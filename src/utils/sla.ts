import type { ComplaintStatus, Priority } from "@prisma/client";

/** Higher priority shrinks the category's base SLA window. */
const PRIORITY_FACTOR: Record<Priority, number> = {
  URGENT: 0.25,
  HIGH: 0.5,
  MEDIUM: 1,
  LOW: 1.5,
};

export const OPEN_STATUSES: ComplaintStatus[] = ["SUBMITTED", "ASSIGNED", "IN_PROGRESS", "REOPENED"];

export function computeSlaDueAt(slaHours: number, priority: Priority, from: Date = new Date()): Date {
  const hours = Math.max(1, Math.round(slaHours * PRIORITY_FACTOR[priority]));
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

interface SlaInput {
  status: ComplaintStatus;
  slaDueAt: Date | null;
  resolvedAt: Date | null;
}

/** Derived SLA view returned with every complaint. */
export function describeSla(c: SlaInput) {
  if (!c.slaDueAt || c.status === "CANCELLED" || c.status === "REJECTED" || c.status === "PENDING_PAYMENT") {
    return { dueAt: c.slaDueAt, breached: false, hoursRemaining: null };
  }
  const reference = c.resolvedAt ?? new Date();
  const breached = reference.getTime() > c.slaDueAt.getTime();
  const isOpen = OPEN_STATUSES.includes(c.status);
  const hoursRemaining = isOpen ? Math.round(((c.slaDueAt.getTime() - Date.now()) / 36e5) * 10) / 10 : null;
  return { dueAt: c.slaDueAt, breached, hoursRemaining };
}
