import { Router } from "express";
import { authenticate } from "../../middlewares/auth";
import { authLimiter } from "../../middlewares/rateLimiter";
import { validate } from "../../middlewares/validate";
import * as controller from "./auth.controller";
import {
  changePasswordSchema,
  googleCallbackQuery,
  googleLoginSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
} from "./auth.validation";

const router = Router();

router.post("/register", authLimiter, validate({ body: registerSchema }), controller.register);
router.post("/login", authLimiter, validate({ body: loginSchema }), controller.login);

// Google (GCP) social login
router.post("/google", authLimiter, validate({ body: googleLoginSchema }), controller.googleLogin); // ID-token flow
router.get("/google", controller.googleRedirect); // browser redirect flow
router.get("/google/callback", validate({ query: googleCallbackQuery }), controller.googleCallback);

router.post("/refresh-token", validate({ body: refreshSchema }), controller.refreshToken);
router.post("/logout", authenticate, validate({ body: refreshSchema }), controller.logout);
router.patch("/change-password", authenticate, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
