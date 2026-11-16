import { PaymentStatus, type Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { CacheKeys, cacheInvalidate } from "../../lib/redis";
import { getStripe } from "../../lib/stripe";
import type { AuthUser } from "../../types/express";
import { ApiError } from "../../utils/ApiError";
import { logAudit } from "../../utils/audit";
import { buildMeta, paginationQuery, sortOrderQuery, toSkipTake } from "../../utils/pagination";
import { computeSlaDueAt } from "../../utils/sla";

// ───────────────────────── Validation ─────────────────────────

export const idParam = z.object({ id: z.uuid("Invalid payment id") });
export const initiateSchema = z.object({ complaintId: z.uuid("Invalid complaintId") });
export const sessionQuery = z.object({ session_id: z.string().min(10, "session_id is required") });
export const refundSchema = z.object({ reason: z.string().trim().min(5).max(500) });
export const listPaymentQuery = z.object({
  ...paginationQuery,
  status: z.enum(PaymentStatus).optional(),
  complaintId: z.uuid().optional(),
  sortOrder: sortOrderQuery,
});

type ListQuery = z.infer<typeof listPaymentQuery>;

const paymentSelect = {
  id: true,
  amount: true,
  currency: true,
  status: true,
  provider: true,
  stripeSessionId: true,
  checkoutUrl: true,
  paidAt: true,
  refundedAt: true,
  createdAt: true,
  complaint: { select: { id: true, trackingCode: true, title: true, status: true, feeStatus: true } },
} satisfies Prisma.PaymentSelect;

/** Stripe expects the smallest currency unit (poisha / cents). */
const toMinorUnits = (amount: Prisma.Decimal | number) => Math.round(Number(amount) * 100);

function stripeFailure(err: unknown, fallback: string): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : fallback;
  return new ApiError(502, fallback, [{ message }]);
}

// ───────────────────────── Initiate ─────────────────────────

/**
 * Creates a Stripe Checkout Session for an unpaid service request.
 * The complaint row is locked (SELECT ... FOR UPDATE) while we look for / create the
 * PENDING payment, so two parallel calls can never open two checkouts for one request.
 */
export async function initiatePayment(user: AuthUser, complaintId: string, ip: string | null, attempt = 0) {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM complaints WHERE id = ${complaintId} FOR UPDATE`;

    const complaint = await tx.complaint.findFirst({ where: { id: complaintId, deletedAt: null } });
    if (!complaint) throw new ApiError(404, "Complaint not found");
    if (complaint.citizenId !== user.id) {
      throw new ApiError(403, "Forbidden: you can only pay for your own service requests");
    }
    if (complaint.feeStatus === "NOT_REQUIRED") throw new ApiError(409, "This complaint does not require a payment");
    if (complaint.feeStatus !== "UNPAID") throw new ApiError(409, "The service fee has already been paid");
    if (complaint.status !== "PENDING_PAYMENT") {
      throw new ApiError(409, `Payment is not possible while the request is ${complaint.status}`);
    }

    const pending = await tx.payment.findFirst({ where: { complaintId, status: "PENDING" } });
    if (pending?.stripeSessionId) return { complaint, payment: pending, reused: true };
    if (pending) {
      const ageMs = Date.now() - pending.createdAt.getTime();
      if (ageMs < 60_000) throw new ApiError(409, "A payment is already being initiated. Retry in a moment");
      await tx.payment.update({ where: { id: pending.id }, data: { status: "FAILED" } }); // orphaned attempt
    }

    const payment = await tx.payment.create({
      data: { complaintId, userId: user.id, amount: complaint.feeAmount, currency: env.PAYMENT_CURRENCY },
    });
    return { complaint, payment, reused: false };
  });

  const stripe = getStripe();
  const { complaint, payment } = outcome;

  if (outcome.reused && payment.stripeSessionId) {
    // An earlier checkout exists: hand it back if it is still open, otherwise settle it and start over.
    const session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId).catch((err) => {
      throw stripeFailure(err, "Could not reach the payment gateway");
    });
    if (session.status === "open") {
      return prisma.payment.findUniqueOrThrow({ where: { id: payment.id }, select: paymentSelect });
    }
    if (session.payment_status === "paid") {
      await fulfillCheckout(session, "initiate");
      throw new ApiError(409, "The service fee has already been paid");
    }
    await prisma.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    if (attempt > 0) throw new ApiError(409, "Could not start a new payment. Please try again");
    return initiatePayment(user, complaintId, ip, attempt + 1);
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: payment.id,
        customer_email: user.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: payment.currency,
              unit_amount: toMinorUnits(payment.amount),
              product_data: {
                name: `Service fee - ${complaint.trackingCode}`,
                description: complaint.title.slice(0, 200),
              },
            },
          },
        ],
        metadata: { paymentId: payment.id, complaintId: complaint.id, trackingCode: complaint.trackingCode },
        success_url: `${env.APP_URL}/api/v1/payments/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.APP_URL}/api/v1/payments/cancel?session_id={CHECKOUT_SESSION_ID}`,
      },
      { idempotencyKey: `checkout-${payment.id}` },
    );
  } catch (err) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
    throw stripeFailure(err, "Could not create the payment session");
  }

  const saved = await prisma.payment.update({
    where: { id: payment.id },
    data: { stripeSessionId: session.id, checkoutUrl: session.url },
    select: paymentSelect,
  });
  await logAudit(prisma, {
    actorId: user.id,
    action: "PAYMENT_INITIATED",
    entity: "Payment",
    entityId: payment.id,
    metadata: { complaintId, amount: Number(payment.amount), currency: payment.currency },
    ipAddress: ip,
  });
  return saved;
}

// ───────────────────────── Fulfilment (webhook + redirect verification) ─────────────────────────

/**
 * Marks a payment as PAID and releases the service request to its department.
 * Idempotent: the webhook and the success redirect may both call it, in any order,
 * and the conditional update lets exactly one of them apply the change.
 */
export async function fulfillCheckout(session: Stripe.Checkout.Session, source: string) {
  if (session.payment_status !== "paid") return;

  const payment = await prisma.payment.findUnique({ where: { stripeSessionId: session.id } });
  if (!payment) return; // not one of ours

  // Never trust the redirect: the amount and currency must match what we asked Stripe to collect.
  if (session.amount_total !== toMinorUnits(payment.amount) || session.currency !== payment.currency.toLowerCase()) {
    console.error("[payment] amount mismatch", { paymentId: payment.id, sessionId: session.id });
    throw new ApiError(409, "Paid amount does not match the service fee");
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ["PENDING", "EXPIRED", "CANCELLED", "FAILED"] } },
      data: { status: "PAID", paidAt: new Date(), stripePaymentIntentId: paymentIntentId },
    });
    if (claimed.count !== 1) return; // already processed by the other path

    const complaint = await tx.complaint.findUniqueOrThrow({
      where: { id: payment.complaintId },
      include: { category: { select: { slaHours: true } } },
    });

    if (complaint.status === "PENDING_PAYMENT") {
      await tx.complaint.update({
        where: { id: complaint.id },
        data: {
          status: "SUBMITTED",
          feeStatus: "PAID",
          slaDueAt: computeSlaDueAt(complaint.category.slaHours, complaint.priority), // SLA starts now
        },
      });
      await tx.statusHistory.create({
        data: {
          complaintId: complaint.id,
          fromStatus: "PENDING_PAYMENT",
          toStatus: "SUBMITTED",
          changedById: payment.userId,
          note: "Service fee paid",
        },
      });
    } else {
      // e.g. the citizen cancelled while the checkout page was still open: keep the money trail, admin refunds.
      await tx.complaint.update({ where: { id: complaint.id }, data: { feeStatus: "PAID" } });
    }

    await logAudit(tx, {
      actorId: payment.userId,
      action: "PAYMENT_COMPLETED",
      entity: "Payment",
      entityId: payment.id,
      metadata: { complaintId: complaint.id, sessionId: session.id, paymentIntentId, source },
    });
  });
  await cacheInvalidate(CacheKeys.publicStats, CacheKeys.dashboard);
}

async function settleUnpaid(sessionId: string, status: "EXPIRED" | "FAILED" | "CANCELLED") {
  await prisma.payment.updateMany({ where: { stripeSessionId: sessionId, status: "PENDING" }, data: { status } });
}

/** Stripe webhook: the signature is verified against the raw request body. */
export async function handleWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, "Webhook is not configured (STRIPE_WEBHOOK_SECRET missing)");
  if (!signature) throw new ApiError(400, "Missing stripe-signature header");

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "Webhook signature verification failed");
  }

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await fulfillCheckout(event.data.object, `webhook:${event.type}`);
      break;
    case "checkout.session.expired":
      await settleUnpaid(event.data.object.id, "EXPIRED");
      break;
    case "checkout.session.async_payment_failed":
      await settleUnpaid(event.data.object.id, "FAILED");
      break;
    default:
      break; // acknowledged but not relevant
  }
  return { received: true, type: event.type };
}

/** Success redirect / manual verification: asks Stripe for the truth, never trusts the query string. */
export async function verifySession(sessionId: string) {
  const exists = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId }, select: { id: true } });
  if (!exists) throw new ApiError(404, "Payment session not found");

  const session = await getStripe()
    .checkout.sessions.retrieve(sessionId)
    .catch((err) => {
      throw stripeFailure(err, "Could not verify the payment with the gateway");
    });
  await fulfillCheckout(session, "verify");
  if (session.status === "expired") await settleUnpaid(sessionId, "EXPIRED");

  return prisma.payment.findUniqueOrThrow({ where: { id: exists.id }, select: paymentSelect });
}

/** Cancel redirect: the citizen backed out of the checkout page. */
export async function cancelSession(sessionId: string) {
  const payment = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId }, select: { id: true } });
  if (!payment) throw new ApiError(404, "Payment session not found");

  const session = await getStripe()
    .checkout.sessions.retrieve(sessionId)
    .catch((err) => {
      throw stripeFailure(err, "Could not reach the payment gateway");
    });
  if (session.payment_status === "paid") {
    await fulfillCheckout(session, "cancel-redirect"); // paid in another tab: honour the payment
  } else {
    if (session.status === "open")
      await getStripe()
        .checkout.sessions.expire(sessionId)
        .catch(() => undefined);
    await settleUnpaid(sessionId, "CANCELLED");
  }
  return prisma.payment.findUniqueOrThrow({ where: { id: payment.id }, select: paymentSelect });
}

// ───────────────────────── Read ─────────────────────────

export async function listPayments(user: AuthUser, query: ListQuery) {
  const where: Prisma.PaymentWhereInput = {
    ...(user.role === "ADMIN" ? {} : { userId: user.id }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.complaintId ? { complaintId: query.complaintId } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where,
      select: { ...paymentSelect, user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: query.sortOrder },
      ...toSkipTake(query.page, query.limit),
    }),
    prisma.payment.count({ where }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}

export async function getPayment(user: AuthUser, id: string) {
  const payment = await prisma.payment.findUnique({
    where: { id },
    select: { ...paymentSelect, userId: true, user: { select: { id: true, name: true, email: true } } },
  });
  if (!payment) throw new ApiError(404, "Payment not found");
  if (user.role !== "ADMIN" && payment.userId !== user.id) {
    throw new ApiError(403, "Forbidden: this payment belongs to another user");
  }
  const { userId, ...rest } = payment;
  return rest;
}

/** Authenticated re-check of a payment against Stripe (useful when a webhook was missed). */
export async function syncPayment(user: AuthUser, id: string) {
  const payment = await getPayment(user, id);
  if (!payment.stripeSessionId) throw new ApiError(409, "This payment has no gateway session yet");
  return verifySession(payment.stripeSessionId);
}

// ───────────────────────── Refund (admin) ─────────────────────────

export async function refundPayment(admin: AuthUser, id: string, reason: string, ip: string | null) {
  const payment = await prisma.payment.findUnique({ where: { id }, include: { complaint: true } });
  if (!payment) throw new ApiError(404, "Payment not found");
  if (payment.status !== "PAID" || !payment.stripePaymentIntentId) {
    throw new ApiError(409, `Only PAID payments can be refunded (current status: ${payment.status})`);
  }
  if (payment.complaint.status !== "REJECTED" && payment.complaint.status !== "CANCELLED") {
    throw new ApiError(409, "A fee can only be refunded after the request is rejected or cancelled");
  }

  // The idempotency key makes a retried request return the same Stripe refund instead of refunding twice.
  const refund = await getStripe()
    .refunds.create(
      { payment_intent: payment.stripePaymentIntentId, metadata: { paymentId: payment.id } },
      { idempotencyKey: `refund-${payment.id}` },
    )
    .catch((err) => {
      throw stripeFailure(err, "The gateway rejected the refund");
    });

  await prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id, status: "PAID" },
      data: { status: "REFUNDED", refundedAt: new Date(), stripeRefundId: refund.id },
    });
    if (updated.count !== 1) return;
    await tx.complaint.update({ where: { id: payment.complaintId }, data: { feeStatus: "REFUNDED" } });
    await logAudit(tx, {
      actorId: admin.id,
      action: "PAYMENT_REFUNDED",
      entity: "Payment",
      entityId: id,
      metadata: { reason, refundId: refund.id, amount: Number(payment.amount) },
      ipAddress: ip,
    });
  });
  await cacheInvalidate(CacheKeys.dashboard);
  return getPayment(admin, id);
}
