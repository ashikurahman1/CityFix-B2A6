import { Router } from "express";
import { authenticate, authorize } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import * as controller from "./payment.controller";
import * as service from "./payment.service";

const router = Router();

// NOTE: POST /payments/webhook is registered in app.ts (it needs the raw body, before express.json()).

// Stripe redirects the citizen's browser here (no Bearer token available): the session id is
// verified server-side with Stripe, so these are safe to expose.
router.get("/success", validate({ query: service.sessionQuery }), controller.success);
router.get("/cancel", validate({ query: service.sessionQuery }), controller.cancel);

router.use(authenticate);

router.post("/initiate", authorize("CITIZEN"), validate({ body: service.initiateSchema }), controller.initiate);
router.get("/", authorize("CITIZEN", "ADMIN"), validate({ query: service.listPaymentQuery }), controller.list);
router.get("/:id", authorize("CITIZEN", "ADMIN"), validate({ params: service.idParam }), controller.getOne);
router.post("/:id/verify", authorize("CITIZEN", "ADMIN"), validate({ params: service.idParam }), controller.sync);
router.post(
  "/:id/refund",
  authorize("ADMIN"),
  validate({ params: service.idParam, body: service.refundSchema }),
  controller.refund,
);

export default router;
