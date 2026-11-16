import rateLimit from "express-rate-limit";

function limiter(windowMinutes: number, limit: number, message: string) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ success: false, message, errors: [] });
    },
  });
}

/** Applied to the whole API. */
export const globalLimiter = limiter(15, 300, "Too many requests. Please try again later");

/** Stricter limit for credential endpoints to slow down brute-force attempts. */
export const authLimiter = limiter(15, 20, "Too many authentication attempts. Please try again in 15 minutes");
