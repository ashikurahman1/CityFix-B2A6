import { type Request, type Response, Router } from "express";
import { authenticate, authorize, currentUser } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { sendResponse } from "../../utils/sendResponse";
import * as service from "./department.service";

const id = (req: Request) => req.params.id as string;

async function list(_req: Request, res: Response) {
  const { q } = res.locals.query as { q?: string };
  sendResponse(res, { message: "Departments retrieved successfully", data: await service.listDepartments(q) });
}

async function getOne(req: Request, res: Response) {
  sendResponse(res, { message: "Department retrieved successfully", data: await service.getDepartment(id(req)) });
}

async function create(req: Request, res: Response) {
  const data = await service.createDepartment(req.body, currentUser(req).id);
  sendResponse(res, { statusCode: 201, message: "Department created successfully", data });
}

async function update(req: Request, res: Response) {
  const data = await service.updateDepartment(id(req), req.body, currentUser(req).id);
  sendResponse(res, { message: "Department updated successfully", data });
}

async function remove(req: Request, res: Response) {
  await service.deleteDepartment(id(req), currentUser(req).id);
  sendResponse(res, { message: "Department deleted successfully" });
}

const router = Router();
const adminOnly = [authenticate, authorize("ADMIN")];

router.get("/", validate({ query: service.listDepartmentQuery }), list);
router.get("/:id", validate({ params: service.idParam }), getOne);
router.post("/", ...adminOnly, validate({ body: service.createDepartmentSchema }), create);
router.patch("/:id", ...adminOnly, validate({ params: service.idParam, body: service.updateDepartmentSchema }), update);
router.delete("/:id", ...adminOnly, validate({ params: service.idParam }), remove);

export default router;
