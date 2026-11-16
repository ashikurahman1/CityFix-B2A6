import { type Request, type Response, Router } from "express";
import adminRoutes from "../modules/admin/admin.routes";
import { getPublicStats } from "../modules/admin/admin.service";
import authRoutes from "../modules/auth/auth.routes";
import categoryRoutes from "../modules/category/category.routes";
import complaintRoutes from "../modules/complaint/complaint.routes";
import departmentRoutes from "../modules/department/department.routes";
import paymentRoutes from "../modules/payment/payment.routes";
import userRoutes from "../modules/user/user.routes";
import { sendResponse } from "../utils/sendResponse";

/** Everything here is mounted under /api/v1 */
const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/departments", departmentRoutes);
router.use("/categories", categoryRoutes);
router.use("/complaints", complaintRoutes);
router.use("/payments", paymentRoutes);
router.use("/admin", adminRoutes);

router.get("/stats/public", async (_req: Request, res: Response) => {
  sendResponse(res, { message: "Public statistics retrieved successfully", data: await getPublicStats() });
});

export default router;
