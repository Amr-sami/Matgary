import Redis, { type Redis as RedisClient } from "ioredis";

// Single shared client kept on globalThis so Next dev's hot reload doesn't
// leak connections (same pattern as lib/db/index.ts). The client is lazy:
// it only opens a TCP connection when the first command runs, so importing
// this module is free.
//
// Failure model: every callsite goes through lib/cache.ts or lib/ratelimit.ts,
// which catch errors and fall through to the source of truth (Postgres) /
// fail-open. That means an outage on the Redis container does NOT bring the
// app down — it just turns into a cache miss.

const REDIS_URL = process.env.REDIS_URL;
const CACHE_DISABLED = process.env.CACHE_DISABLED === "1";

const globalForRedis = globalThis as unknown as {
  __redis?: RedisClient | null;
  __redisLogged?: boolean;
};

function build(): RedisClient | null {
  if (CACHE_DISABLED) {
    if (!globalForRedis.__redisLogged) {
      console.log("[redis] CACHE_DISABLED=1 — running without cache");
      globalForRedis.__redisLogged = true;
    }
    return null;
  }
  if (!REDIS_URL) {
    if (!globalForRedis.__redisLogged) {
      console.log("[redis] REDIS_URL not set — running without cache");
      globalForRedis.__redisLogged = true;
    }
    return null;
  }
  const client = new Redis(REDIS_URL, {
    // Eager connect so the very first command after process boot doesn't
    // race the TCP handshake. Combined with the offline queue (default on)
    // a brief blip during reconnect just buffers a few commands instead of
    // erroring — and the cache helpers swallow real failures regardless.
    maxRetriesPerRequest: 2,
    // Backoff caps at 2s so transient outages don't slow request latency.
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  client.on("error", (err) => {
    // Don't spam — log only the first error per up/down cycle.
    if (!globalForRedis.__redisLogged) {
      console.warn("[redis] connection error", err.message);
      globalForRedis.__redisLogged = true;
    }
  });
  client.on("ready", () => {
    if (globalForRedis.__redisLogged) {
      console.log("[redis] connected");
    }
    globalForRedis.__redisLogged = false;
  });

  return client;
}

export const redis: RedisClient | null = globalForRedis.__redis ?? build();
if (process.env.NODE_ENV !== "production") {
  globalForRedis.__redis = redis;
}

export function isCacheEnabled(): boolean {
  return redis !== null;
}
