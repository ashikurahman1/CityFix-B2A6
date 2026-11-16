import { randomInt } from "node:crypto";
import type { Complaint, ComplaintStatus, Prisma } from "@prisma/client";
import { uploadBuffer } from "../../lib/cloudinary";
import { prisma } from "../../lib/prisma";
import { CacheKeys, cacheInvalidate } from "../../lib/redis";
import type { AuthUser } from "../../types/express";
import { ApiError } from "../../utils/ApiError";
import { logAudit } from "../../utils/audit";
import { buildMeta, toSkipTake } from "../../utils/pagination";
import { OPEN_STATUSES, computeSlaDueAt, describeSla } from "../../utils/sla";
import type {
  AssignInput,
  CommentInput,
  CreateComplaintInput,
  FeedbackInput,
  ListComplaintQuery,
  StatusInput,
  UpdateComplaintInput,
} from "./complaint.validation";

type Tx = Prisma.TransactionClient;

/** A staff member may hold at most this many ASSIGNED / IN_PROGRESS / REOPENED complaints. */
const MAX_ACTIVE_ASSIGNMENTS = 10;
const REOPEN_WINDOW_DAYS = 7;
const MAX_ATTACHMENTS = 5;
const ACTIVE_WORK: ComplaintStatus[] = ["ASSIGNED", "IN_PROGRESS", "REOPENED"];

// ───────────────────────── Selects ─────────────────────────

const listSelect = {
  id: true,
  trackingCode: true,
  title: true,
  type: true,
  priority: true,
  status: true,
  address: true,
  ward: true,
  feeAmount: true,
  feeStatus: true,
  slaDueAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  citizen: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.ComplaintSelect;

const detailInclude = {
  category: { select: { id: true, name: true, slaHours: true } },
  department: { select: { id: true, name: true } },
  citizen: { select: { id: true, name: true, email: true, phone: true } },
  assignedTo: { select: { id: true, name: true, email: true } },
  attachments: { select: { id: true, url: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
  feedback: { select: { rating: true, comment: true, createdAt: true } },
  payments: {
    select: { id: true, amount: true, currency: true, status: true, paidAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.ComplaintInclude;

const withSla = <T extends { status: ComplaintStatus; slaDueAt: Date | null; resolvedAt: Date | null }>(c: T) => ({
  ...c,
  sla: describeSla(c),
});

// ───────────────────────── Access control ─────────────────────────

/** Row-level scope: what each role is allowed to see. */
function scopeWhere(user: AuthUser): Prisma.ComplaintWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.role === "CITIZEN") return { citizenId: user.id };
  return {
    status: { not: "PENDING_PAYMENT" }, // unpaid service requests are not routed to departments yet
    OR: [{ assignedToId: user.id }, ...(user.departmentId ? [{ departmentId: user.departmentId }] : [])],
  };
}

function canAccess(user: AuthUser, c: Complaint): boolean {
  if (user.role === "ADMIN") return true;
  if (user.role === "CITIZEN") return c.citizenId === user.id;
  if (c.status === "PENDING_PAYMENT") return false;
  return c.assignedToId === user.id || (user.departmentId !== null && c.departmentId === user.departmentId);
}

/** 404 when missing / soft-deleted, 403 when it exists but is outside the caller's scope. */
async function findAccessible(user: AuthUser, id: string, db: Tx | typeof prisma = prisma): Promise<Complaint> {
  const complaint = await db.complaint.findFirst({ where: { id, deletedAt: null } });
  if (!complaint) throw new ApiError(404, "Complaint not found");
  if (!canAccess(user, complaint)) throw new ApiError(403, "Forbidden: you do not have access to this complaint");
  return complaint;
}

function assertOwner(user: AuthUser, c: Complaint) {
  if (c.citizenId !== user.id) throw new ApiError(403, "Forbidden: only the citizen who filed it can do this");
}

// ───────────────────────── State machine ─────────────────────────

/**
 * Moves a complaint to a new status inside a transaction.
 * The conditional `updateMany` (optimistic concurrency on the current status) guarantees
 * that two simultaneous requests cannot both apply a transition from the same state.
 */
async function transition(
  tx: Tx,
  complaint: Complaint,
  to: ComplaintStatus,
  actor: { id: string | null; ip?: string | null },
  options: {
    note?: string;
    data?: Prisma.ComplaintUncheckedUpdateManyInput;
    extraWhere?: Prisma.ComplaintWhereInput;
    action?: string;
    metadata?: Record<string, string | number | null>;
  } = {},
) {
  const result = await tx.complaint.updateMany({
    where: { id: complaint.id, status: complaint.status, deletedAt: null, ...options.extraWhere },
    data: { status: to, ...options.data },
  });
  if (result.count !== 1) {
    throw new ApiError(409, "Complaint was changed by another request. Reload it and try again");
  }
  await tx.statusHistory.create({
    data: {
      complaintId: complaint.id,
      fromStatus: complaint.status,
      toStatus: to,
      note: options.note,
      changedById: actor.id,
    },
  });
  await logAudit(tx, {
    actorId: actor.id,
    action: options.action ?? "COMPLAINT_STATUS_CHANGED",
    entity: "Complaint",
    entityId: complaint.id,
    metadata: { from: complaint.status, to, note: options.note ?? null, ...options.metadata },
    ipAddress: actor.ip,
  });
}

const STAFF_TRANSITIONS: Partial<Record<ComplaintStatus, ComplaintStatus[]>> = {
  ASSIGNED: ["IN_PROGRESS"],
  REOPENED: ["IN_PROGRESS"],
  IN_PROGRESS: ["RESOLVED"],
};

const ADMIN_TRANSITIONS: Partial<Record<ComplaintStatus, ComplaintStatus[]>> = {
  SUBMITTED: ["REJECTED"],
  ASSIGNED: ["IN_PROGRESS", "REJECTED"],
  REOPENED: ["IN_PROGRESS", "REJECTED"],
  IN_PROGRESS: ["RESOLVED"],
  RESOLVED: ["CLOSED"],
};

const invalidateStats = () => cacheInvalidate(CacheKeys.publicStats, CacheKeys.dashboard);

// ───────────────────────── Create / read ─────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function generateTrackingCode(now = new Date()): string {
  const date = now.toISOString().slice(2, 10).replaceAll("-", "");
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `CF-${date}-${suffix}`;
}

export async function createComplaint(user: AuthUser, input: CreateComplaintInput, ip: string | null) {
  const category = await prisma.category.findFirst({
    where: { id: input.categoryId, deletedAt: null, isActive: true, department: { deletedAt: null } },
  });
  if (!category) {
    throw new ApiError(400, "Validation failed", [
      { path: "categoryId", message: "Category does not exist or is no longer available" },
    ]);
  }

  // Routing: the category decides the department, the type and whether a fee must be paid first.
  const requiresPayment = Number(category.serviceFee) > 0;
  const status: ComplaintStatus = requiresPayment ? "PENDING_PAYMENT" : "SUBMITTED";

  const complaint = await prisma.$transaction(async (tx) => {
    const created = await tx.complaint.create({
      data: {
        trackingCode: generateTrackingCode(),
        title: input.title,
        description: input.description,
        priority: input.priority,
        address: input.address,
        ward: input.ward,
        latitude: input.latitude,
        longitude: input.longitude,
        type: category.type,
        status,
        feeAmount: category.serviceFee,
        feeStatus: requiresPayment ? "UNPAID" : "NOT_REQUIRED",
        // The SLA clock of a paid request starts when the payment is confirmed.
        slaDueAt: requiresPayment ? null : computeSlaDueAt(category.slaHours, input.priority),
        citizenId: user.id,
        categoryId: category.id,
        departmentId: category.departmentId,
      },
      include: detailInclude,
    });
    await tx.statusHistory.create({
      data: { complaintId: created.id, toStatus: status, changedById: user.id, note: "Request filed" },
    });
    await logAudit(tx, {
      actorId: user.id,
      action: "COMPLAINT_CREATED",
      entity: "Complaint",
      entityId: created.id,
      metadata: { trackingCode: created.trackingCode, categoryId: category.id },
      ipAddress: ip,
    });
    return created;
  });

  await invalidateStats();
  return {
    ...withSla(complaint),
    nextStep: requiresPayment
      ? "Pay the service fee via POST /api/v1/payments/initiate to submit this request"
      : "Your complaint has been routed to the responsible department",
  };
}

export async function listComplaints(user: AuthUser, query: ListComplaintQuery) {
  const and: Prisma.ComplaintWhereInput[] = [{ deletedAt: null }, scopeWhere(user)];

  if (query.status) and.push({ status: query.status });
  if (query.priority) and.push({ priority: query.priority });
  if (query.type) and.push({ type: query.type });
  if (query.categoryId) and.push({ categoryId: query.categoryId });
  if (query.departmentId) and.push({ departmentId: query.departmentId });
  if (query.assignedToId) and.push({ assignedToId: query.assignedToId });
  if (query.ward) and.push({ ward: { equals: query.ward, mode: "insensitive" } });
  if (query.assignedToMe) and.push({ assignedToId: user.id });
  if (query.unassigned) and.push({ assignedToId: null, status: "SUBMITTED" });
  if (query.overdue) and.push({ status: { in: OPEN_STATUSES }, slaDueAt: { lt: new Date() } });
  if (query.from || query.to) and.push({ createdAt: { gte: query.from, lte: query.to } });
  if (query.q) {
    and.push({
      OR: [
        { title: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
        { address: { contains: query.q, mode: "insensitive" } },
        { trackingCode: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }

  const where: Prisma.ComplaintWhereInput = { AND: and };
  const [items, total] = await prisma.$transaction([
    prisma.complaint.findMany({
      where,
      select: listSelect,
      orderBy: [{ [query.sortBy]: query.sortOrder }, { id: "asc" }],
      ...toSkipTake(query.page, query.limit),
    }),
    prisma.complaint.count({ where }),
  ]);

  return { items: items.map(withSla), meta: buildMeta(query.page, query.limit, total) };
}

export async function getComplaint(user: AuthUser, id: string) {
  await findAccessible(user, id);
  const complaint = await prisma.complaint.findUniqueOrThrow({ where: { id }, include: detailInclude });
  return withSla(complaint);
}

/** Public, anonymised tracking view (no personal data, no description). */
export async function trackComplaint(trackingCode: string) {
  const complaint = await prisma.complaint.findFirst({
    where: { trackingCode, deletedAt: null },
    select: {
      trackingCode: true,
      type: true,
      status: true,
      priority: true,
      ward: true,
      slaDueAt: true,
      resolvedAt: true,
      createdAt: true,
      category: { select: { name: true } },
      department: { select: { name: true } },
      history: { select: { toStatus: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!complaint) throw new ApiError(404, "No request found for this tracking code");
  return withSla(complaint);
}

export async function getTimeline(user: AuthUser, id: string) {
  await findAccessible(user, id);
  return prisma.statusHistory.findMany({
    where: { complaintId: id },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      createdAt: true,
      changedBy: { select: { id: true, name: true, role: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

// ───────────────────────── Update / soft delete ─────────────────────────

export async function updateComplaint(user: AuthUser, id: string, input: UpdateComplaintInput, ip: string | null) {
  const complaint = await findAccessible(user, id);
  const { priority, ...contentFields } = input;
  let data: Prisma.ComplaintUpdateInput;

  if (user.role === "ADMIN") {
    // Admins triage (priority); they never rewrite what the citizen reported.
    if (Object.keys(contentFields).length > 0 || !priority) {
      throw new ApiError(403, "Admins can only change the priority of a complaint");
    }
    data = { priority };
  } else {
    assertOwner(user, complaint);
    if (priority) throw new ApiError(403, "Priority can only be changed by an admin after filing");
    if (complaint.status !== "SUBMITTED" && complaint.status !== "PENDING_PAYMENT") {
      throw new ApiError(409, `A complaint can no longer be edited once it is ${complaint.status}`);
    }
    data = contentFields;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.complaint.update({ where: { id }, data, include: detailInclude });
    await logAudit(tx, {
      actorId: user.id,
      action: "COMPLAINT_UPDATED",
      entity: "Complaint",
      entityId: id,
      metadata: { fields: Object.keys(input) },
      ipAddress: ip,
    });
    return result;
  });
  return withSla(updated);
}

export async function deleteComplaint(user: AuthUser, id: string, ip: string | null) {
  const complaint = await findAccessible(user, id);

  if (user.role !== "ADMIN") {
    assertOwner(user, complaint);
    if (!["CANCELLED", "REJECTED", "CLOSED"].includes(complaint.status)) {
      throw new ApiError(409, "Only cancelled, rejected or closed complaints can be deleted. Cancel it first");
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.complaint.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit(tx, {
      actorId: user.id,
      action: "COMPLAINT_DELETED",
      entity: "Complaint",
      entityId: id,
      metadata: { status: complaint.status },
      ipAddress: ip,
    });
  });
  await invalidateStats();
}

// ───────────────────────── Workflow ─────────────────────────

async function assertStaffCapacity(tx: Tx, staffId: string) {
  const active = await tx.complaint.count({
    where: { assignedToId: staffId, deletedAt: null, status: { in: ACTIVE_WORK } },
  });
  if (active >= MAX_ACTIVE_ASSIGNMENTS) {
    throw new ApiError(409, `Staff member already has ${active} active complaints (limit ${MAX_ACTIVE_ASSIGNMENTS})`);
  }
}

/** Admin assigns (or re-assigns) a complaint to a staff member of the owning department. */
export async function assignComplaint(admin: AuthUser, id: string, input: AssignInput, ip: string | null) {
  await prisma.$transaction(async (tx) => {
    const complaint = await findAccessible(admin, id, tx);
    if (!["SUBMITTED", "ASSIGNED", "REOPENED"].includes(complaint.status)) {
      throw new ApiError(409, `A ${complaint.status} complaint cannot be assigned`);
    }
    if (complaint.assignedToId === input.staffId) {
      throw new ApiError(409, "Complaint is already assigned to this staff member");
    }

    const staff = await tx.user.findFirst({
      where: { id: input.staffId, role: "STAFF", isActive: true, deletedAt: null },
      select: { id: true, name: true, departmentId: true },
    });
    if (!staff) {
      throw new ApiError(400, "Validation failed", [{ path: "staffId", message: "Active staff member not found" }]);
    }
    if (staff.departmentId !== complaint.departmentId) {
      throw new ApiError(409, "Staff member belongs to a different department than this complaint");
    }
    await assertStaffCapacity(tx, staff.id);

    await transition(
      tx,
      complaint,
      "ASSIGNED",
      { id: admin.id, ip },
      {
        note: input.note ?? `Assigned to ${staff.name}`,
        data: { assignedToId: staff.id, assignedAt: new Date() },
        action: "COMPLAINT_ASSIGNED",
        metadata: { staffId: staff.id, previousStaffId: complaint.assignedToId },
      },
    );
  });
  return getComplaint(admin, id);
}

/** Staff self-assigns an unassigned complaint from their own department queue. */
export async function claimComplaint(staff: AuthUser, id: string, ip: string | null) {
  await prisma.$transaction(async (tx) => {
    const complaint = await findAccessible(staff, id, tx);
    if (complaint.departmentId !== staff.departmentId) {
      throw new ApiError(403, "Forbidden: you can only claim complaints routed to your department");
    }
    if (complaint.status !== "SUBMITTED" || complaint.assignedToId) {
      throw new ApiError(409, "Complaint has already been assigned");
    }
    await assertStaffCapacity(tx, staff.id);

    // `assignedToId: null` in the WHERE makes the claim atomic: the first request wins, the second gets 409.
    await transition(
      tx,
      complaint,
      "ASSIGNED",
      { id: staff.id, ip },
      {
        note: "Claimed from the department queue",
        data: { assignedToId: staff.id, assignedAt: new Date() },
        extraWhere: { assignedToId: null },
        action: "COMPLAINT_CLAIMED",
        metadata: { staffId: staff.id },
      },
    );
  });
  return getComplaint(staff, id);
}

export async function updateStatus(user: AuthUser, id: string, input: StatusInput, ip: string | null) {
  const complaint = await findAccessible(user, id);

  if (user.role === "STAFF" && complaint.assignedToId !== user.id) {
    throw new ApiError(403, "Forbidden: only the assigned staff member can update this complaint");
  }

  const allowed = (user.role === "ADMIN" ? ADMIN_TRANSITIONS : STAFF_TRANSITIONS)[complaint.status] ?? [];
  if (!allowed.includes(input.status)) {
    throw new ApiError(409, `Invalid status transition: ${complaint.status} -> ${input.status}`, [
      {
        path: "status",
        message: allowed.length ? `Allowed: ${allowed.join(", ")}` : "No transition allowed for your role",
      },
    ]);
  }

  const now = new Date();
  const data: Prisma.ComplaintUncheckedUpdateManyInput =
    input.status === "RESOLVED"
      ? { resolvedAt: now, resolutionNote: input.note }
      : input.status === "REJECTED"
        ? { closedAt: now, resolutionNote: input.note }
        : input.status === "CLOSED"
          ? { closedAt: now }
          : {};

  await prisma.$transaction((tx) =>
    transition(tx, complaint, input.status, { id: user.id, ip }, { note: input.note, data }),
  );
  await invalidateStats();

  const updated = await getComplaint(user, id);
  const refundHint =
    input.status === "REJECTED" && complaint.feeStatus === "PAID"
      ? "The service fee was already paid: refund it via POST /api/v1/payments/:id/refund"
      : undefined;
  return { ...updated, ...(refundHint ? { refundHint } : {}) };
}

export async function cancelComplaint(citizen: AuthUser, id: string, reason: string | undefined, ip: string | null) {
  const complaint = await findAccessible(citizen, id);
  assertOwner(citizen, complaint);
  if (complaint.status !== "PENDING_PAYMENT" && complaint.status !== "SUBMITTED") {
    throw new ApiError(409, `A ${complaint.status} complaint can no longer be cancelled`);
  }

  await prisma.$transaction(async (tx) => {
    await transition(
      tx,
      complaint,
      "CANCELLED",
      { id: citizen.id, ip },
      {
        note: reason ?? "Cancelled by citizen",
        data: { closedAt: new Date() },
        action: "COMPLAINT_CANCELLED",
      },
    );
    // Abandon any checkout that was started but never paid.
    await tx.payment.updateMany({ where: { complaintId: id, status: "PENDING" }, data: { status: "CANCELLED" } });
  });
  await invalidateStats();
  return getComplaint(citizen, id);
}

export async function reopenComplaint(citizen: AuthUser, id: string, reason: string, ip: string | null) {
  const complaint = await findAccessible(citizen, id);
  assertOwner(citizen, complaint);
  if (complaint.status !== "RESOLVED" || !complaint.resolvedAt) {
    throw new ApiError(409, "Only resolved complaints can be reopened");
  }
  const deadline = new Date(complaint.resolvedAt.getTime() + REOPEN_WINDOW_DAYS * 24 * 36e5);
  if (new Date() > deadline) {
    throw new ApiError(409, `Complaints can only be reopened within ${REOPEN_WINDOW_DAYS} days of resolution`);
  }

  const category = await prisma.category.findUniqueOrThrow({ where: { id: complaint.categoryId } });

  await prisma.$transaction((tx) =>
    transition(
      tx,
      complaint,
      "REOPENED",
      { id: citizen.id, ip },
      {
        note: reason,
        // A reopened complaint gets a fresh SLA window and goes back to the same staff member.
        data: { resolvedAt: null, slaDueAt: computeSlaDueAt(category.slaHours, complaint.priority) },
        action: "COMPLAINT_REOPENED",
      },
    ),
  );
  await invalidateStats();
  return getComplaint(citizen, id);
}

/** Citizen rates the resolution; this also closes the complaint. */
export async function submitFeedback(citizen: AuthUser, id: string, input: FeedbackInput, ip: string | null) {
  const complaint = await findAccessible(citizen, id);
  assertOwner(citizen, complaint);
  if (complaint.status !== "RESOLVED") {
    throw new ApiError(409, "Feedback can only be given once the complaint is resolved");
  }

  await prisma.$transaction(async (tx) => {
    await tx.feedback.create({
      data: { complaintId: id, citizenId: citizen.id, rating: input.rating, comment: input.comment },
    });
    await transition(
      tx,
      complaint,
      "CLOSED",
      { id: citizen.id, ip },
      {
        note: `Closed with a ${input.rating}/5 rating`,
        data: { closedAt: new Date() },
        action: "COMPLAINT_FEEDBACK_SUBMITTED",
        metadata: { rating: input.rating },
      },
    );
  });
  await invalidateStats();
  return getComplaint(citizen, id);
}

// ───────────────────────── Comments & attachments ─────────────────────────

export async function addComment(user: AuthUser, id: string, input: CommentInput) {
  await findAccessible(user, id);
  if (input.isInternal && user.role === "CITIZEN") {
    throw new ApiError(403, "Forbidden: only staff and admins can post internal notes");
  }
  return prisma.comment.create({
    data: { complaintId: id, authorId: user.id, body: input.body, isInternal: input.isInternal },
    select: {
      id: true,
      body: true,
      isInternal: true,
      createdAt: true,
      author: { select: { id: true, name: true, role: true } },
    },
  });
}

export async function listComments(user: AuthUser, id: string) {
  await findAccessible(user, id);
  return prisma.comment.findMany({
    where: { complaintId: id, deletedAt: null, ...(user.role === "CITIZEN" ? { isInternal: false } : {}) },
    select: {
      id: true,
      body: true,
      isInternal: true,
      createdAt: true,
      author: { select: { id: true, name: true, role: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function addAttachments(user: AuthUser, id: string, files: Express.Multer.File[]) {
  const complaint = await findAccessible(user, id);
  if (files.length === 0) {
    throw new ApiError(400, "Validation failed", [
      { path: "files", message: "Attach at least one file (field name: files)" },
    ]);
  }
  if (["CLOSED", "CANCELLED", "REJECTED"].includes(complaint.status)) {
    throw new ApiError(409, `Files cannot be added to a ${complaint.status} complaint`);
  }
  const existing = await prisma.attachment.count({ where: { complaintId: id } });
  if (existing + files.length > MAX_ATTACHMENTS) {
    throw new ApiError(
      409,
      `A complaint can have at most ${MAX_ATTACHMENTS} attachments (${existing} already uploaded)`,
    );
  }

  const uploaded = await Promise.all(files.map((file) => uploadBuffer(file.buffer, `cityfix/complaints/${id}`)));

  return prisma.$transaction(
    uploaded.map((upload, index) => {
      const file = files[index] as Express.Multer.File;
      return prisma.attachment.create({
        data: {
          complaintId: id,
          uploadedById: user.id,
          url: upload.url,
          publicId: upload.publicId,
          fileName: file.originalname.slice(0, 200),
          mimeType: file.mimetype,
          sizeBytes: file.size,
        },
        select: { id: true, url: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
      });
    }),
  );
}
