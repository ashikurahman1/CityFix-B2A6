import { defineConfig } from "tsup";

// Bundles the API into a single CommonJS file (dist/server.js) that Vercel's
// @vercel/node builder serves. Dependencies stay external (node_modules).
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: true,
});
