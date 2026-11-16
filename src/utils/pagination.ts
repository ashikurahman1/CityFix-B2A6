import { z } from "zod";
import type { PaginationMeta } from "./sendResponse";

/** Shared `?page=1&limit=10` query fragment. Spread into module query schemas. */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
};

export const sortOrderQuery = z.enum(["asc", "desc"]).default("desc");

export function toSkipTake(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

export function buildMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Query-string booleans: "true"/"1" => true, "false"/"0" => false. */
export const booleanQuery = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();
