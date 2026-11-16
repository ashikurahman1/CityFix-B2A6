import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { CacheKeys, cacheInvalidate, cached } from "../../lib/redis";
import { ApiError } from "../../utils/ApiError";
import { logAudit } from "../../utils/audit";

export const idParam = z.object({ id: z.uuid("Invalid id") });

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  contactEmail: z.email("Invalid contact email").optional(),
  contactPhone: z.string().trim().max(20).optional(),
});

export const updateDepartmentSchema = createDepartmentSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export const listDepartmentQuery = z.object({ q: z.string().trim().max(100).optional() });

type CreateInput = z.infer<typeof createDepartmentSchema>;
type UpdateInput = z.infer<typeof updateDepartmentSchema>;

const publicSelect = {
  id: true,
  name: true,
  description: true,
  contactEmail: true,
  contactPhone: true,
  createdAt: true,
} satisfies Prisma.DepartmentSelect;

export function listDepartments(q?: string) {
  const load = () =>
    prisma.department.findMany({
      where: { deletedAt: null, ...(q ? { name: { contains: q, mode: "insensitive" } } : {}) },
      select: { ...publicSelect, _count: { select: { categories: { where: { deletedAt: null } } } } },
      orderBy: { name: "asc" },
    });
  // Only the unfiltered list is cached: it is the hot path and trivial to invalidate.
  return q ? load() : cached(CacheKeys.departments, 300, load);
}

export async function getDepartment(id: string) {
  const department = await prisma.department.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...publicSelect,
      categories: {
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true, type: true, slaHours: true, serviceFee: true },
        orderBy: { name: "asc" },
      },
      _count: { select: { staff: { where: { deletedAt: null, isActive: true } } } },
    },
  });
  if (!department) throw new ApiError(404, "Department not found");
  return department;
}

export async function createDepartment(input: CreateInput, actorId: string) {
  const department = await prisma.$transaction(async (tx) => {
    const created = await tx.department.create({ data: input, select: publicSelect });
    await logAudit(tx, { actorId, action: "DEPARTMENT_CREATED", entity: "Department", entityId: created.id });
    return created;
  });
  await cacheInvalidate(CacheKeys.departments);
  return department;
}

export async function updateDepartment(id: string, input: UpdateInput, actorId: string) {
  await getDepartment(id);
  const department = await prisma.$transaction(async (tx) => {
    const updated = await tx.department.update({ where: { id }, data: input, select: publicSelect });
    await logAudit(tx, {
      actorId,
      action: "DEPARTMENT_UPDATED",
      entity: "Department",
      entityId: id,
      metadata: input,
    });
    return updated;
  });
  await cacheInvalidate(CacheKeys.departments, CacheKeys.categories);
  return department;
}

/** Soft delete. Blocked while the department still owns categories or open complaints. */
export async function deleteDepartment(id: string, actorId: string) {
  await getDepartment(id);

  await prisma.$transaction(async (tx) => {
    const [categories, openComplaints] = await Promise.all([
      tx.category.count({ where: { departmentId: id, deletedAt: null } }),
      tx.complaint.count({
        where: { departmentId: id, deletedAt: null, status: { notIn: ["CLOSED", "REJECTED", "CANCELLED"] } },
      }),
    ]);
    if (categories > 0 || openComplaints > 0) {
      throw new ApiError(409, "Department is still in use", [
        {
          message: `${categories} active categories and ${openComplaints} open complaints must be moved or closed first`,
        },
      ]);
    }
    await tx.department.update({ where: { id }, data: { deletedAt: new Date() } });
    await tx.user.updateMany({ where: { departmentId: id }, data: { departmentId: null } });
    await logAudit(tx, { actorId, action: "DEPARTMENT_DELETED", entity: "Department", entityId: id });
  });
  await cacheInvalidate(CacheKeys.departments);
}
