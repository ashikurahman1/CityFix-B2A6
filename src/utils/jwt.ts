import type { Role } from "@prisma/client";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env";

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: "refresh";
  exp: number;
}

type ExpiresIn = SignOptions["expiresIn"];

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ role, type: "access" }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as ExpiresIn,
  });
}

export function signRefreshToken(userId: string, tokenId: string): string {
  return jwt.sign({ type: "refresh" }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    jwtid: tokenId,
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as ExpiresIn,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  if (payload.type !== "access") throw new jwt.JsonWebTokenError("Invalid token type");
  return payload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  if (payload.type !== "refresh") throw new jwt.JsonWebTokenError("Invalid token type");
  return payload;
}
