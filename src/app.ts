import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler";
import { globalLimiter } from "./middlewares/rateLimiter";
import { webhook } from "./modules/payment/payment.controller";
import apiRoutes from "./routes";
import { sendResponse } from "./utils/sendResponse";

const app = express();

// Behind Vercel / Render's proxy: needed for correct client IPs (rate limiting + audit logs).
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet());

const allowedOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());
app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Stripe signs the raw bytes, so the webhook must be registered BEFORE the JSON body parser.
app.post("/api/v1/payments/webhook", express.raw({ type: "application/json" }), webhook);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.get("/", (_req: Request, res: Response) => {
  sendResponse(res, {
    message: "CityFix API - City Complaint & Service Request Platform",
    data: { version: "v1", basePath: "/api/v1", health: "/health", environment: env.isProduction ? "production" : env.NODE_ENV },
  });
});

app.get("/health", async (_req: Request, res: Response) => {
  await prisma.$queryRaw`SELECT 1`;
  sendResponse(res, {
    message: "API is healthy",
    data: { database: "up", uptimeSeconds: Math.round(process.uptime()) },
  });
});

app.use("/api/v1", globalLimiter, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
