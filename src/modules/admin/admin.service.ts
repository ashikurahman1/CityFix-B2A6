import { type Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { CacheKeys, cached } from "../../lib/redis";
import type { AuthUser } from "../../types/express";
import { ApiError } from "../../utils/ApiError";
import { logAudit } from "../../utils/audit";
import { booleanQuery, buildMeta, paginationQuery, sortOrderQuery, toSkipTake } from "../../utils/pagination";
import { OPEN_STATUSES } from "../../utils/sla";

// ───────────────────────── Validation ─────────────────────────

export const idParam = z.object({ id: z.uuid("Invalid user id") });

const staffNeedsDepartment = (v: { role: Role; departmentId?: string }) =>
  v.role !== "STAFF" || Boolean(v.departmentId);
const staffNeedsDepartmentError = { path: ["departmentId"], message: "departmentId is required for the STAFF role" };

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().toLowerCase().pipe(z.email("Invalid email address")),
    password: z.string().min(8, "Password must be at least 8 characters").max(72),
    role: z.enum(Role),
    departmentId: z.uuid("Invalid departmentId").optional(),
    phone: z.string().trim().max(20).optional(),
  })
  .refine(staffNeedsDepartment, staffNeedsDepartmentError);

export const changeRoleSchema = z
  .object({ role: z.enum(Role), departmentId: z.uuid("Invalid departmentId").optional() })
  .refine(staffNeedsDepartment, staffNeedsDepartmentError);

export const changeStatusSchema = z.object({ isActive: z.boolean("isActive must be true or false") });

export const listUserQuery = z.object({
  ...paginationQuery,
  q: z.string().trim().max(100).optional(),
  role: z.enum(Role).optional(),
  departmentId: z.uuid().optional(),
  isActive: booleanQuery,
  sortBy: z.enum(["createdAt", "name", "email", "lastLoginAt"]).default("createdAt"),
  sortOrder: sortOrderQuery,
});

export const listAuditQuery = z.object({
  ...paginationQuery,
  action: z.string().trim().toUpperCase().max(60).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  actorId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortOrder: sortOrderQuery,
});

type CreateUserInput = z.infer<typeof createUserSchema>;
type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
type ListUserQuery = z.infer<typeof listUserQuery>;
type ListAuditQuery = z.infer<typeof listAuditQuery>;

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  phone: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

// ───────────────────────── Helpers ─────────────────────────

async function findUser(id: string) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

async function assertDepartment(departmentId: string) {
  const department = await prisma.department.findFirst({ where: { id: departmentId, deletedAt: null } });
  if (!department) {
    throw new ApiError(400, "Validation failed", [{ path: "departmentId", message: "Department does not exist" }]);
  }
}

function assertNotSelf(admin: AuthUser, targetId: string, action: string) {
  if (admin.id === targetId) throw new ApiError(409, `You cannot ${action} your own account`);
}

/** A staff member with unfinished work must hand it over before leaving the role. */
async function assertNoActiveAssignments(userId: string) {
  const active = await prisma.complaint.count({
    where: { assignedToId: userId, deletedAt: null, status: { in: ["ASSIGNED", "IN_PROGRESS", "REOPENED"] } },
  });
  if (active > 0) {
    throw new ApiError(409, `User still has ${active} active complaints. Re-assign them first`);
  }
}

const revokeSessions = (tx: Prisma.TransactionClient, userId: string) =>
  tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

// ───────────────────────── User management ─────────────────────────

export async function listUsers(query: ListUserQuery) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.role ? { role: query.role } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { email: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: { [query.sortBy]: query.sortOrder },
      ...toSkipTake(query.page, query.limit),
    }),
    prisma.user.count({ where }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}

/** Admins create staff / admin accounts (public registration only creates citizens). */
export async function createUser(admin: AuthUser, input: CreateUserInput, ip: string | null) {
  if (input.departmentId) await assertDepartment(input.departmentId);
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
        phone: input.phone,
        departmentId: input.role === "STAFF" ? input.departmentId : null,
      },
      select: userSelect,
    });
    await logAudit(tx, {
      actorId: admin.id,
      action: "USER_CREATED_BY_ADMIN",
      entity: "User",
      entityId: user.id,
      metadata: { role: input.role, departmentId: input.departmentId ?? null },
      ipAddress: ip,
    });
    return user;
  });
}

export async function changeRole(admin: AuthUser, id: string, input: ChangeRoleInput, ip: string | null) {
  assertNotSelf(admin, id, "change the role of");
  const user = await findUser(id);
  if (input.departmentId) await assertDepartment(input.departmentId);

  const departmentId = input.role === "STAFF" ? (input.departmentId ?? null) : null;
  if (user.role === input.role && user.departmentId === departmentId) {
    throw new ApiError(409, `User already has the ${input.role} role`);
  }
  // Leaving the STAFF role, or moving to another department, strands assigned work.
  if (user.role === "STAFF" && (input.role !== "STAFF" || user.departmentId !== departmentId)) {
    await assertNoActiveAssignments(id);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id },
      data: { role: input.role, departmentId },
      select: userSelect,
    });
    await revokeSessions(tx, id); // the user must log in again to pick up the new permissions
    await logAudit(tx, {
      actorId: admin.id,
      action: "USER_ROLE_CHANGED",
      entity: "User",
      entityId: id,
      metadata: {
        fromRole: user.role,
        toRole: input.role,
        fromDepartmentId: user.departmentId,
        toDepartmentId: departmentId,
      },
      ipAddress: ip,
    });
    return updated;
  });
}

export async function changeStatus(admin: AuthUser, id: string, isActive: boolean, ip: string | null) {
  assertNotSelf(admin, id, "deactivate");
  const user = await findUser(id);
  if (user.isActive === isActive) {
    throw new ApiError(409, `User is already ${isActive ? "active" : "deactivated"}`);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id }, data: { isActive }, select: userSelect });
    if (!isActive) await revokeSessions(tx, id);
    await logAudit(tx, {
      actorId: admin.id,
      action: isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      entity: "User",
      entityId: id,
      ipAddress: ip,
    });
    return updated;
  });
}

export async function deleteUser(admin: AuthUser, id: string, ip: string | null) {
  assertNotSelf(admin, id, "delete");
  const user = await findUser(id);
  if (user.role === "STAFF") await assertNoActiveAssignments(id);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await revokeSessions(tx, id);
    await logAudit(tx, {
      actorId: admin.id,
      action: "USER_DELETED",
      entity: "User",
      entityId: id,
      metadata: { email: user.email, role: user.role },
      ipAddress: ip,
    });
  });
}

// ───────────────────────── Audit logs ─────────────────────────

export async function listAuditLogs(query: ListAuditQuery) {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.entity ? { entity: { equals: query.entity, mode: "insensitive" } } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        actor: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { createdAt: query.sortOrder },
      ...toSkipTake(query.page, query.limit),
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}

// ───────────────────────── Statistics ─────────────────────────

interface ResolutionRow {
  resolved: number;
  withinSla: number;
  avgHours: number | null;
}

async function resolutionMetrics(): Promise<ResolutionRow> {
  const rows = await prisma.$queryRaw<ResolutionRow[]>`
    SELECT
      COUNT(*)::int                                                              AS "resolved",
      COUNT(*) FILTER (WHERE "slaDueAt" IS NULL OR "resolvedAt" <= "slaDueAt")::int AS "withinSla",
      (AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt"))) / 3600)::float8     AS "avgHours"
    FROM complaints
    WHERE "resolvedAt" IS NOT NULL AND "deletedAt" IS NULL`;
  return rows[0] ?? { resolved: 0, withinSla: 0, avgHours: null };
}

const round1 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);

export function getDashboardStats() {
  return cached(CacheKeys.dashboard, 60, async () => {
    const now = new Date();
    const live: Prisma.ComplaintWhereInput = { deletedAt: null };

    const [
      byStatus,
      byPriority,
      byDepartment,
      departments,
      overdue,
      unassigned,
      usersByRole,
      revenue,
      rating,
      metrics,
      workload,
    ] = await Promise.all([
      prisma.complaint.groupBy({ by: ["status"], where: live, _count: { _all: true } }),
      prisma.complaint.groupBy({
        by: ["priority"],
        where: { ...live, status: { in: OPEN_STATUSES } },
        _count: { _all: true },
      }),
      prisma.complaint.groupBy({ by: ["departmentId"], where: live, _count: { _all: true } }),
      prisma.department.findMany({ select: { id: true, name: true } }),
      prisma.complaint.count({ where: { ...live, status: { in: OPEN_STATUSES }, slaDueAt: { lt: now } } }),
      prisma.complaint.count({ where: { ...live, status: "SUBMITTED", assignedToId: null } }),
      prisma.user.groupBy({ by: ["role"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.payment.aggregate({ where: { status: "PAID" }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.feedback.aggregate({ _avg: { rating: true }, _count: { _all: true } }),
      resolutionMetrics(),
      prisma.complaint.groupBy({
        by: ["assignedToId"],
        where: { ...live, assignedToId: { not: null }, status: { in: ["ASSIGNED", "IN_PROGRESS", "REOPENED"] } },
        _count: { _all: true },
        orderBy: { _count: { assignedToId: "desc" } },
        take: 5,
      }),
    ]);

    const staffIds = workload.map((w) => w.assignedToId).filter((v): v is string => v !== null);
    const staff = await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } });
    const nameOf = (list: { id: string; name: string }[], id: string | null) =>
      list.find((x) => x.id === id)?.name ?? "Unknown";

    return {
      generatedAt: now,
      complaints: {
        total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
        openByPriority: Object.fromEntries(byPriority.map((row) => [row.priority, row._count._all])),
        byDepartment: byDepartment.map((row) => ({
          departmentId: row.departmentId,
          department: nameOf(departments, row.departmentId),
          count: row._count._all,
        })),
        overdue,
        unassigned,
      },
      performance: {
        resolved: metrics.resolved,
        avgResolutionHours: round1(metrics.avgHours),
        slaCompliancePercent: metrics.resolved ? round1((metrics.withinSla / metrics.resolved) * 100) : null,
        averageRating: round1(rating._avg.rating),
        feedbackCount: rating._count._all,
        busiestStaff: workload.map((w) => ({
          staffId: w.assignedToId,
          name: nameOf(staff, w.assignedToId),
          activeComplaints: w._count._all,
        })),
      },
      users: Object.fromEntries(usersByRole.map((row) => [row.role, row._count._all])),
      payments: {
        paidCount: revenue._count._all,
        totalRevenue: Number(revenue._sum.amount ?? 0),
        currency: env.PAYMENT_CURRENCY,
      },
    };
  });
}

/** Aggregate, anonymous numbers for the public transparency endpoint. */
export function getPublicStats() {
  return cached(CacheKeys.publicStats, 120, async () => {
    const live: Prisma.ComplaintWhereInput = { deletedAt: null, status: { notIn: ["PENDING_PAYMENT", "CANCELLED"] } };
    const [total, open, resolved, rating, metrics, topCategories, categories] = await Promise.all([
      prisma.complaint.count({ where: live }),
      prisma.complaint.count({ where: { deletedAt: null, status: { in: OPEN_STATUSES } } }),
      prisma.complaint.count({ where: { deletedAt: null, status: { in: ["RESOLVED", "CLOSED"] } } }),
      prisma.feedback.aggregate({ _avg: { rating: true } }),
      resolutionMetrics(),
      prisma.complaint.groupBy({
        by: ["categoryId"],
        where: live,
        _count: { _all: true },
        orderBy: { _count: { categoryId: "desc" } },
        take: 5,
      }),
      prisma.category.findMany({ select: { id: true, name: true } }),
    ]);

    return {
      totalRequests: total,
      open,
      resolved,
      resolutionRatePercent: total ? round1((resolved / total) * 100) : null,
      avgResolutionHours: round1(metrics.avgHours),
      averageRating: round1(rating._avg.rating),
      topCategories: topCategories.map((row) => ({
        category: categories.find((c) => c.id === row.categoryId)?.name ?? "Unknown",
        count: row._count._all,
      })),
    };
  });
}
