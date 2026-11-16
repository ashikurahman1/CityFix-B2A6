import type { Request, Response } from "express";
import { currentUser } from "../../middlewares/auth";
import { clientIp } from "../../utils/audit";
import { sendResponse } from "../../utils/sendResponse";
import * as authService from "./auth.service";

const ctx = (req: Request) => ({ ip: clientIp(req), userAgent: req.get("user-agent") });

export async function register(req: Request, res: Response) {
  const data = await authService.register(req.body, ctx(req));
  sendResponse(res, { statusCode: 201, message: "Registration successful", data });
}

export async function login(req: Request, res: Response) {
  const data = await authService.login(req.body, ctx(req));
  sendResponse(res, { message: "Login successful", data });
}

export async function googleLogin(req: Request, res: Response) {
  const data = await authService.loginWithGoogleIdToken(req.body.idToken, ctx(req));
  sendResponse(res, { message: "Google login successful", data });
}

export function googleRedirect(_req: Request, res: Response) {
  res.redirect(authService.getGoogleAuthUrl());
}

export async function googleCallback(_req: Request, res: Response) {
  const { code } = res.locals.query as { code: string };
  const data = await authService.loginWithGoogleCode(code, ctx(_req));
  sendResponse(res, { message: "Google login successful", data });
}

export async function refreshToken(req: Request, res: Response) {
  const data = await authService.refresh(req.body.refreshToken, ctx(req));
  sendResponse(res, { message: "Token refreshed successfully", data });
}

export async function logout(req: Request, res: Response) {
  await authService.logout(req.body.refreshToken, currentUser(req).id);
  sendResponse(res, { message: "Logged out successfully" });
}

export async function changePassword(req: Request, res: Response) {
  await authService.changePassword(currentUser(req).id, req.body, ctx(req));
  sendResponse(res, { message: "Password changed successfully. Please log in again on other devices" });
}
