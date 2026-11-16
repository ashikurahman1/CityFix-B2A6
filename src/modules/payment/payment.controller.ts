import type { Request, Response } from "express";
import { currentUser } from "../../middlewares/auth";
import { clientIp } from "../../utils/audit";
import { sendResponse } from "../../utils/sendResponse";
import * as service from "./payment.service";

const id = (req: Request) => req.params.id as string;

export async function initiate(req: Request, res: Response) {
  const data = await service.initiatePayment(currentUser(req), req.body.complaintId, clientIp(req));
  sendResponse(res, {
    statusCode: 201,
    message: "Payment session created. Open checkoutUrl in a browser to pay",
    data,
  });
}

/** Mounted with express.raw() in app.ts, so req.body is the untouched Buffer Stripe signed. */
export async function webhook(req: Request, res: Response) {
  const data = await service.handleWebhook(req.body as Buffer, req.get("stripe-signature"));
  sendResponse(res, { message: "Webhook processed", data });
}

export async function success(_req: Request, res: Response) {
  const { session_id } = res.locals.query as { session_id: string };
  const data = await service.verifySession(session_id);
  sendResponse(res, {
    message: data.status === "PAID" ? "Payment verified successfully" : `Payment is ${data.status}`,
    data,
  });
}

export async function cancel(_req: Request, res: Response) {
  const { session_id } = res.locals.query as { session_id: string };
  const data = await service.cancelSession(session_id);
  sendResponse(res, { message: `Checkout was not completed. Payment is ${data.status}`, data });
}

export async function list(req: Request, res: Response) {
  const { items, meta } = await service.listPayments(currentUser(req), res.locals.query);
  sendResponse(res, { message: "Payments retrieved successfully", data: items, meta });
}

export async function getOne(req: Request, res: Response) {
  const data = await service.getPayment(currentUser(req), id(req));
  sendResponse(res, { message: "Payment retrieved successfully", data });
}

export async function sync(req: Request, res: Response) {
  const data = await service.syncPayment(currentUser(req), id(req));
  sendResponse(res, { message: `Payment status verified with the gateway: ${data.status}`, data });
}

export async function refund(req: Request, res: Response) {
  const data = await service.refundPayment(currentUser(req), id(req), req.body.reason, clientIp(req));
  sendResponse(res, { message: "Payment refunded successfully", data });
}
