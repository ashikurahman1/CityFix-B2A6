import { randomUUID } from "node:crypto";
import type { Prisma, User } from "@prisma/client";
import bcrypt from "bcryptjs";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../utils/ApiError";
import { logAudit } from "../../utils/audit";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../utils/jwt";
import type { ChangePasswordInput, LoginInput, RegisterInput } from "./auth.validation";

interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

const GOOGLE_REDIRECT_URI = `${env.APP_URL}/api/v1/auth/google/callback`;

export function toPublicUser(user: User) {
  const { passwordHash, googleId, deletedAt, ...rest } = user;
  return { ...rest, hasPassword: Boolean(passwordHash), googleLinked: Boolean(googleId) };
}

/** Creates a refresh-token row and returns a signed access + refresh pair. */
async function issueTokens(db: Prisma.TransactionClient | typeof prisma, user: User, ctx: RequestContext) {
  const tokenId = randomUUID();
  const refreshToken = signRefreshToken(user.id, tokenId);
  const { exp } = verifyRefreshToken(refreshToken);

  await db.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      expiresAt: new Date(exp * 1000),
      userAgent: ctx.userAgent?.slice(0, 255) ?? null,
    },
  });

  return {
    accessToken: signAccessToken(user.id, user.role),
    refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  };
}

function assertCanSignIn(user: User) {
  if (user.deletedAt) throw new ApiError(401, "Invalid email or password");
  if (!user.isActive) throw new ApiError(403, "Your account has been deactivated. Contact the city admin");
}

async function completeLogin(user: User, ctx: RequestContext, method: "PASSWORD" | "GOOGLE") {
  const [tokens, updated] = await prisma.$transaction(async (tx) => {
    const t = await issueTokens(tx, user, ctx);
    const u = await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await logAudit(tx, {
      actorId: user.id,
      action: "USER_LOGIN",
      entity: "User",
      entityId: user.id,
      metadata: { method },
      ipAddress: ctx.ip,
    });
    return [t, u] as const;
  });
  return { user: toPublicUser(updated), ...tokens };
}

export async function register(input: RegisterInput, ctx: RequestContext) {
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) {
    throw new ApiError(409, "Email is already registered", [{ path: "email", message: "Email is already in use" }]);
  }

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        phone: input.phone,
        address: input.address,
        role: "CITIZEN", // public sign-up can only ever create citizens
      },
    });
    const tokens = await issueTokens(tx, user, ctx);
    await logAudit(tx, {
      actorId: user.id,
      action: "USER_REGISTERED",
      entity: "User",
      entityId: user.id,
      ipAddress: ctx.ip,
    });
    return { user: toPublicUser(user), ...tokens };
  });
}

export async function login(input: LoginInput, ctx: RequestContext) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Same message for "no such user" and "wrong password" to avoid account enumeration.
  if (!user || user.deletedAt) throw new ApiError(401, "Invalid email or password");
  if (!user.passwordHash) {
    throw new ApiError(401, "This account uses Google sign-in. Continue with Google or set a password first");
  }
  const matches = await bcrypt.compare(input.password, user.passwordHash);
  if (!matches) throw new ApiError(401, "Invalid email or password");

  assertCanSignIn(user);
  return completeLogin(user, ctx, "PASSWORD");
}

// ───────────────────────── Google (GCP) social login ─────────────────────────

function googleClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new ApiError(503, "Google login is not configured (GOOGLE_CLIENT_ID missing)");
  }
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

/** URL of Google's consent screen (browser redirect flow). */
export function getGoogleAuthUrl(): string {
  if (!env.GOOGLE_CLIENT_SECRET) {
    throw new ApiError(503, "Google redirect login is not configured (GOOGLE_CLIENT_SECRET missing)");
  }
  return googleClient().generateAuthUrl({
    access_type: "online",
    prompt: "select_account",
    scope: ["openid", "email", "profile"],
  });
}

/** Verifies a Google ID token, then finds / links / creates the local account. */
export async function loginWithGoogleIdToken(idToken: string, ctx: RequestContext) {
  let payload: TokenPayload | undefined;
  try {
    const ticket = await googleClient().verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, "Invalid Google token");
  }

  if (!payload?.sub || !payload.email) throw new ApiError(401, "Google account has no email address");
  if (!payload.email_verified) throw new ApiError(401, "Google email address is not verified");

  const email = payload.email.toLowerCase();
  let user = await prisma.user.findFirst({ where: { OR: [{ googleId: payload.sub }, { email }] } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        name: payload.name ?? email.split("@")[0] ?? "Citizen",
        email,
        googleId: payload.sub,
        avatarUrl: payload.picture,
        role: "CITIZEN",
      },
    });
    await logAudit(prisma, {
      actorId: user.id,
      action: "USER_REGISTERED",
      entity: "User",
      entityId: user.id,
      metadata: { method: "GOOGLE" },
      ipAddress: ctx.ip,
    });
  } else {
    assertCanSignIn(user);
    if (!user.googleId) {
      // Existing email/password account: link it to the verified Google identity.
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId: payload.sub, avatarUrl: user.avatarUrl ?? payload.picture },
      });
    }
  }

  return completeLogin(user, ctx, "GOOGLE");
}

/** Exchanges the `code` from Google's redirect for tokens, then logs the user in. */
export async function loginWithGoogleCode(code: string, ctx: RequestContext) {
  let idToken: string | null | undefined;
  try {
    const { tokens } = await googleClient().getToken(code);
    idToken = tokens.id_token;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, "Google authorization code is invalid or expired");
  }
  if (!idToken) throw new ApiError(401, "Google did not return an ID token");
  return loginWithGoogleIdToken(idToken, ctx);
}

// ───────────────────────── Token management ─────────────────────────

/** Refresh-token rotation with reuse detection. */
export async function refresh(refreshToken: string, ctx: RequestContext) {
  const payload = verifyRefreshToken(refreshToken);

  const stored = await prisma.refreshToken.findUnique({ where: { id: payload.jti }, include: { user: true } });
  if (!stored || stored.userId !== payload.sub) throw new ApiError(401, "Invalid refresh token");

  if (stored.revokedAt) {
    // A rotated token was replayed: assume theft and sign the user out everywhere.
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new ApiError(401, "Refresh token has already been used. Please log in again");
  }
  if (stored.expiresAt < new Date()) throw new ApiError(401, "Refresh token has expired");
  assertCanSignIn(stored.user);

  return prisma.$transaction(async (tx) => {
    // Conditional update makes rotation race-safe: only one concurrent request wins.
    const revoked = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new ApiError(401, "Refresh token has already been used. Please log in again");
    return issueTokens(tx, stored.user, ctx);
  });
}

export async function logout(refreshToken: string, userId: string) {
  const payload = verifyRefreshToken(refreshToken);
  if (payload.sub !== userId) throw new ApiError(403, "This refresh token belongs to another account");
  await prisma.refreshToken.updateMany({
    where: { id: payload.jti, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changePassword(userId: string, input: ChangePasswordInput, ctx: RequestContext) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (user.passwordHash) {
    if (!input.currentPassword) {
      throw new ApiError(400, "Validation failed", [
        { path: "currentPassword", message: "Current password is required" },
      ]);
    }
    const matches = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!matches) throw new ApiError(401, "Current password is incorrect");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_SALT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    // Force every other session to log in again with the new password.
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await logAudit(tx, {
      actorId: userId,
      action: "USER_PASSWORD_CHANGED",
      entity: "User",
      entityId: userId,
      ipAddress: ctx.ip,
    });
  });
}
