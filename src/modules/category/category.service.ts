import { type Prisma, RequestType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { CacheKeys, cacheInvalidate, cached } from "../../lib/redis";
import { ApiError } from "../../utils/ApiError";
import { logAudit } from "../../utils/audit";
import { booleanQuery } from "../../utils/pagination";

export const idParam = z.object({ id: z.uuid("Invalid id") });

const base = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  type: z.enum(RequestType).default("COMPLAINT"),
  departmentId: z.uuid("Invalid departmentId"),
  slaHours: z.coerce.number().int().min(1, "slaHours must be at least 1").max(720).default(72),
  serviceFee: z.coerce.number().min(0).max(1_000_000).default(0),
  isActive: z.boolean().default(true),
});

// A paid category must be a SERVICE; complaints are always free to file.
const feeRule = (v: { type?: RequestType; serviceFee?: number }) =>
  !(v.type === "COMPLAINT" && (v.serviceFee ?? 0) > 0);
const feeRuleError = { path: ["serviceFee"], message: "Only SERVICE categories can have a fee" };

export const createCategorySchema = base.refine(feeRule, feeRuleError);

export const updateCategorySchema = z
  .object({
    name: base.shape.name,
    description: base.shape.description,
    type: z.enum(RequestType),
    departmentId: base.shape.departmentId,
    slaHours: z.coerce.number().int().min(1).max(720),
    serviceFee: z.coerce.number().min(0).max(1_000_000),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

export const listCategoryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(RequestType).optional(),
  departmentId: z.uuid("Invalid departmentId").optional(),
  paid: booleanQuery,
});

type CreateInput = z.infer<typeof createCategorySchema>;
type UpdateInput = z.infer<typeof updateCategorySchema>;
type ListQuery = z.infer<typeof listCategoryQuery>;

const publicSelect = {
  id: true,
  name: true,
  description: true,
  type: true,
  slaHours: true,
  serviceFee: true,
  isActive: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.CategorySelect;

async function assertDepartmentExists(departmentId: string) {
  const department = await prisma.department.findFirst({ where: { id: departmentId, deletedAt: null } });
  if (!department) {
    throw new ApiError(400, "Validation failed", [{ path: "departmentId", message: "Department does not exist" }]);
  }
}

export function listCategories(query: ListQuery) {
  const where: Prisma.CategoryWhereInput = {
    deletedAt: null,
    isActive: true,
    department: { deletedAt: null },
    ...(query.q ? { name: { contains: query.q, mode: "insensitive" } } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.paid === undefined ? {} : { serviceFee: query.paid ? { gt: 0 } : { equals: 0 } }),
  };
  const key = `${CacheKeys.categories}:${JSON.stringify(query)}`;
  return cached(key, 300, () =>
    prisma.category.findMany({ where, select: publicSelect, orderBy: [{ type: "asc" }, { name: "asc" }] }),
  );
}

export async function getCategory(id: string) {
  const category = await prisma.category.findFirst({ where: { id, deletedAt: null }, select: publicSelect });
  if (!category) throw new ApiError(404, "Category not found");
  return category;
}

export async function createCategory(input: CreateInput, actorId: string) {
  await assertDepartmentExists(input.departmentId);
  const category = await prisma.$transaction(async (tx) => {
    const created = await tx.category.create({ data: input, select: publicSelect });
    await logAudit(tx, { actorId, action: "CATEGORY_CREATED", entity: "Category", entityId: created.id });
    return created;
  });
  await cacheInvalidate(CacheKeys.categories, CacheKeys.departments);
  return category;
}

export async function updateCategory(id: string, input: UpdateInput, actorId: string) {
  const current = await getCategory(id);
  if (input.departmentId) await assertDepartmentExists(input.departmentId);

  const type = input.type ?? current.type;
  const fee = input.serviceFee ?? Number(current.serviceFee);
  if (type === "COMPLAINT" && fee > 0) {
    throw new ApiError(400, "Validation failed", [
      { path: "serviceFee", message: "Only SERVICE categories can have a fee" },
    ]);
  }

  const category = await prisma.$transaction(async (tx) => {
    const updated = await tx.category.update({ where: { id }, data: input, select: publicSelect });
    await logAudit(tx, {
      actorId,
      action: "CATEGORY_UPDATED",
      entity: "Category",
      entityId: id,
      metadata: input,
    });
    return updated;
  });
  await cacheInvalidate(CacheKeys.categories, CacheKeys.departments);
  return category;
}

/** Soft delete: existing complaints keep their category, new ones can no longer use it. */
export async function deleteCategory(id: string, actorId: string) {
  await getCategory(id);
  await prisma.$transaction(async (tx) => {
    await tx.category.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await logAudit(tx, { actorId, action: "CATEGORY_DELETED", entity: "Category", entityId: id });
  });
  await cacheInvalidate(CacheKeys.categories, CacheKeys.departments);
}
