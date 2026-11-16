import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { authenticate, currentUser } from "../../middlewares/auth";
import { validate } from "../../middlewares/validate";
import { prisma } from "../../lib/prisma";
import { sendResponse } from "../../utils/sendResponse";
import { toPublicUser } from "../auth/auth.service";

const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{7,15}$/, "Invalid phone number")
      .nullable(),
    address: z.string().trim().max(255).nullable(),
    avatarUrl: z.url("avatarUrl must be a valid URL").nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });

async function getMe(req: Request, res: Response) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: currentUser(req).id },
    include: { department: { select: { id: true, name: true } } },
  });
  const [complaints, assigned] = await Promise.all([
    prisma.complaint.count({ where: { citizenId: user.id, deletedAt: null } }),
    prisma.complaint.count({
      where: { assignedToId: user.id, deletedAt: null, status: { in: ["ASSIGNED", "IN_PROGRESS", "REOPENED"] } },
    }),
  ]);
  const { department, ...rest } = user;
  sendResponse(res, {
    message: "Profile retrieved successfully",
    data: {
      ...toPublicUser(rest),
      department,
      stats: { complaintsSubmitted: complaints, activeAssignments: assigned },
    },
  });
}

async function updateMe(req: Request, res: Response) {
  // Only whitelisted profile fields reach this point: role / email / isActive cannot be self-edited.
  const user = await prisma.user.update({ where: { id: currentUser(req).id }, data: req.body });
  sendResponse(res, { message: "Profile updated successfully", data: toPublicUser(user) });
}

const router = Router();

router.get("/me", authenticate, getMe);
router.patch("/me", authenticate, validate({ body: updateMeSchema }), updateMe);

export default router;
