import app from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";

// On Vercel the exported Express app is the serverless handler and must not bind a port.
if (!process.env.VERCEL) {
  const server = app.listen(env.PORT, () => {
    console.log(`CityFix API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export default app;
