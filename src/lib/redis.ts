import Redis from "ioredis";
import { env } from "../config/env";

/**
 * Redis is optional. When REDIS_URL is missing or the server is unreachable,
 * every helper degrades to a no-op so the API keeps working without a cache.
 */
let client: Redis | null = null;

if (env.REDIS_URL) {
  client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
  });
  client.on("error", (err) => {
    if (!env.isProduction) console.warn("[redis]", err.message);
  });
  client.connect().catch(() => undefined);
}

export const CacheKeys = {
  departments: "cache:departments",
  categories: "cache:categories",
  publicStats: "cache:stats:public",
  dashboard: "cache:stats:dashboard",
} as const;

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!client || client.status !== "ready") return null;
  try {
    const raw = await client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!client || client.status !== "ready") return;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // cache failures must never break a request
  }
}

/** Deletes exact keys and every key that starts with `<key>:`. */
export async function cacheInvalidate(...keys: string[]): Promise<void> {
  if (!client || client.status !== "ready") return;
  try {
    for (const key of keys) {
      const children = await client.keys(`${key}:*`);
      await client.del(key, ...children);
    }
  } catch {
    // ignore
  }
}

/** Cache-aside helper: returns the cached value or computes + stores it. */
export async function cached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const fresh = await compute();
  await cacheSet(key, fresh, ttlSeconds);
  return fresh;
}
