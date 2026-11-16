import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { env } from "../config/env";
import { ApiError, type ErrorDetail } from "../utils/ApiError";

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

interface NormalisedError {
  statusCode: number;
  message: string;
  errors: ErrorDetail[];
}

function normalise(err: unknown): NormalisedError {
  if (err instanceof ApiError) {
    return { statusCode: err.statusCode, message: err.message, errors: err.errors };
  }

  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      message: "Validation failed",
      errors: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }

  if (err instanceof jwt.TokenExpiredError) {
    return { statusCode: 401, message: "Token has expired", errors: [{ message: "jwt expired" }] };
  }
  if (err instanceof jwt.JsonWebTokenError) {
    return { statusCode: 401, message: "Invalid token", errors: [{ message: err.message }] };
  }

  if (err instanceof MulterError) {
    return { statusCode: 400, message: "File upload rejected", errors: [{ path: err.field, message: err.message }] };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002": {
        const target = (err.meta?.target as string[] | undefined)?.join(", ") ?? "field";
        return {
          statusCode: 409,
          message: "A record with the same value already exists",
          errors: [{ path: target, message: `Duplicate value for ${target}` }],
        };
      }
      case "P2025":
        return { statusCode: 404, message: "Record not found", errors: [] };
      case "P2003":
        return { statusCode: 400, message: "Related record does not exist or is still in use", errors: [] };
      default:
        return { statusCode: 400, message: "Database request failed", errors: [{ message: err.code }] };
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    return { statusCode: 400, message: "Invalid data sent to the database", errors: [] };
  }

  // body-parser errors (malformed JSON, payload too large, ...)
  if (typeof err === "object" && err !== null && "type" in err && "status" in err) {
    const e = err as { type: string; status: number };
    if (e.type === "entity.parse.failed") {
      return { statusCode: 400, message: "Malformed JSON body", errors: [] };
    }
    if (e.type === "entity.too.large") {
      return { statusCode: 413, message: "Request body is too large", errors: [] };
    }
  }

  return { statusCode: 500, message: "Internal server error", errors: [] };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const { statusCode, message, errors } = normalise(err);

  if (statusCode >= 500) console.error("[error]", err);

  res.status(statusCode).json({
    success: false,
    message,
    errors,
    ...(statusCode >= 500 && !env.isProduction && err instanceof Error ? { stack: err.stack } : {}),
  });
}
