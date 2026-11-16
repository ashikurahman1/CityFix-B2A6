import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * Client key for rate limiting. Behind Netlify Functions the socket address can be missing,
 * so fall back to the platform's client-IP header before giving up.
 */
function clientKey(req: Request): string {
  const ip = req.ip ?? req.get("x-nf-client-connection-ip");
  return ip ? ipKeyGenerator(ip) : "unknown-client";
}

function limiter(windowMinutes: number, limit: number, message: string) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: clientKey,
    handler: (_req, res) => {
      res.status(429).json({ success: false, message, errors: [] });
    },
  });
}

/** Applied to the whole API. */
export const globalLimiter = limiter(15, 300, "Too many requests. Please try again later");

/** Stricter limit for credential endpoints to slow down brute-force attempts. */
export const authLimiter = limiter(15, 20, "Too many authentication attempts. Please try again in 15 minutes");
