import type { Role } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import type { AuthUser } from "../types/express";
import { ApiError } from "../utils/ApiError";
import { verifyAccessToken } from "../utils/jwt";

/**
 * Verifies the Bearer access token and loads the current user from the DB,
 * so deactivated / deleted accounts and role changes take effect immediately.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "Authentication required. Send 'Authorization: Bearer <accessToken>'");
  }

  const payload = verifyAccessToken(header.slice(7).trim());

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, deletedAt: null },
    select: { id: true, email: true, name: true, role: true, departmentId: true, isActive: true },
  });

  if (!user) throw new ApiError(401, "The account for this token no longer exists");
  if (!user.isActive) throw new ApiError(403, "Your account has been deactivated. Contact the city admin");

  req.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    departmentId: user.departmentId,
  };
  next();
}

/** Role guard. Use after `authenticate`: authorize("ADMIN", "STAFF") */
export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new ApiError(401, "Authentication required");
    if (!roles.includes(req.user.role)) {
      throw new ApiError(403, `Forbidden: this action requires one of the roles [${roles.join(", ")}]`);
    }
    next();
  };
}

/** Narrowing helper for controllers behind `authenticate`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new ApiError(401, "Authentication required");
  return req.user;
}
