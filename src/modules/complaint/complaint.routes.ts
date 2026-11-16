import { Router } from "express";
import { authenticate, authorize } from "../../middlewares/auth";
import { uploadAttachments } from "../../middlewares/upload";
import { validate } from "../../middlewares/validate";
import * as controller from "./complaint.controller";
import * as v from "./complaint.validation";

const router = Router();
const params = v.idParam;

// Public: anonymous tracking by code (must be registered before "/:id")
router.get("/track/:trackingCode", validate({ params: v.trackingParam }), controller.track);

router.use(authenticate);

// Core resource
router.post("/", authorize("CITIZEN"), validate({ body: v.createComplaintSchema }), controller.create);
router.get("/", validate({ query: v.listComplaintQuery }), controller.list); // role-scoped, paginated, filterable
router.get("/:id", validate({ params }), controller.getOne);
router.patch(
  "/:id",
  authorize("CITIZEN", "ADMIN"),
  validate({ params, body: v.updateComplaintSchema }),
  controller.update,
);
router.delete("/:id", authorize("CITIZEN", "ADMIN"), validate({ params }), controller.remove); // soft delete

// Workflow / business operations
router.post("/:id/assign", authorize("ADMIN"), validate({ params, body: v.assignSchema }), controller.assign);
router.post("/:id/claim", authorize("STAFF"), validate({ params }), controller.claim);
router.patch(
  "/:id/status",
  authorize("STAFF", "ADMIN"),
  validate({ params, body: v.statusSchema }),
  controller.updateStatus,
);
router.post("/:id/cancel", authorize("CITIZEN"), validate({ params, body: v.optionalReasonSchema }), controller.cancel);
router.post("/:id/reopen", authorize("CITIZEN"), validate({ params, body: v.reasonSchema }), controller.reopen);
router.post("/:id/feedback", authorize("CITIZEN"), validate({ params, body: v.feedbackSchema }), controller.feedback);

// Collaboration
router.get("/:id/timeline", validate({ params }), controller.timeline);
router.get("/:id/comments", validate({ params }), controller.listComments);
router.post("/:id/comments", validate({ params, body: v.commentSchema }), controller.addComment);
router.post("/:id/attachments", validate({ params }), uploadAttachments, controller.addAttachments);

export default router;
