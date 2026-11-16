import { type Request, type Response, Router } from "express";
import { authenticate, authorize, currentUser } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { clientIp } from "../../utils/audit";
import { sendResponse } from "../../utils/sendResponse";
import * as service from "./admin.service";

const id = (req: Request) => req.params.id as string;

async function listUsers(_req: Request, res: Response) {
  const { items, meta } = await service.listUsers(res.locals.query);
  sendResponse(res, { message: "Users retrieved successfully", data: items, meta });
}

async function createUser(req: Request, res: Response) {
  const data = await service.createUser(currentUser(req), req.body, clientIp(req));
  sendResponse(res, { statusCode: 201, message: "User created successfully", data });
}

async function changeRole(req: Request, res: Response) {
  const data = await service.changeRole(currentUser(req), id(req), req.body, clientIp(req));
  sendResponse(res, { message: "User role updated successfully", data });
}

async function changeStatus(req: Request, res: Response) {
  const data = await service.changeStatus(currentUser(req), id(req), req.body.isActive, clientIp(req));
  sendResponse(res, { message: `User ${data.isActive ? "activated" : "deactivated"} successfully`, data });
}

async function deleteUser(req: Request, res: Response) {
  await service.deleteUser(currentUser(req), id(req), clientIp(req));
  sendResponse(res, { message: "User deleted successfully" });
}

async function dashboardStats(_req: Request, res: Response) {
  sendResponse(res, {
    message: "Dashboard statistics retrieved successfully",
    data: await service.getDashboardStats(),
  });
}

async function auditLogs(_req: Request, res: Response) {
  const { items, meta } = await service.listAuditLogs(res.locals.query);
  sendResponse(res, { message: "Audit logs retrieved successfully", data: items, meta });
}

const router = Router();

// Every route in this module is admin-only.
router.use(authenticate, authorize("ADMIN"));

router.get("/users", validate({ query: service.listUserQuery }), listUsers);
router.post("/users", validate({ body: service.createUserSchema }), createUser);
router.patch("/users/:id/role", validate({ params: service.idParam, body: service.changeRoleSchema }), changeRole);
router.patch(
  "/users/:id/status",
  validate({ params: service.idParam, body: service.changeStatusSchema }),
  changeStatus,
);
router.delete("/users/:id", validate({ params: service.idParam }), deleteUser);
router.get("/dashboard-stats", dashboardStats);
router.get("/audit-logs", validate({ query: service.listAuditQuery }), auditLogs);

export default router;
