import type { Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

/**
 * Records a critical action. Pass the transaction client so the audit row
 * commits (or rolls back) together with the change it describes.
 */
export function logAudit(db: Db, entry: AuditEntry) {
  return db.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
