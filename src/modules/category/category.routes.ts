import { type Request, type Response, Router } from "express";
import { authenticate, authorize, currentUser } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { sendResponse } from "../../utils/sendResponse";
import * as service from "./category.service";

const id = (req: Request) => req.params.id as string;

async function list(_req: Request, res: Response) {
  const data = await service.listCategories(res.locals.query);
  sendResponse(res, { message: "Categories retrieved successfully", data });
}

async function getOne(req: Request, res: Response) {
  sendResponse(res, { message: "Category retrieved successfully", data: await service.getCategory(id(req)) });
}

async function create(req: Request, res: Response) {
  const data = await service.createCategory(req.body, currentUser(req).id);
  sendResponse(res, { statusCode: 201, message: "Category created successfully", data });
}

async function update(req: Request, res: Response) {
  const data = await service.updateCategory(id(req), req.body, currentUser(req).id);
  sendResponse(res, { message: "Category updated successfully", data });
}

async function remove(req: Request, res: Response) {
  await service.deleteCategory(id(req), currentUser(req).id);
  sendResponse(res, { message: "Category deleted successfully" });
}

const router = Router();
const adminOnly = [authenticate, authorize("ADMIN")];

router.get("/", validate({ query: service.listCategoryQuery }), list);
router.get("/:id", validate({ params: service.idParam }), getOne);
router.post("/", ...adminOnly, validate({ body: service.createCategorySchema }), create);
router.patch("/:id", ...adminOnly, validate({ params: service.idParam, body: service.updateCategorySchema }), update);
router.delete("/:id", ...adminOnly, validate({ params: service.idParam }), remove);

export default router;
