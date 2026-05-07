import { redis } from "./redis";

// Strict key contract — every cache key MUST go through one of the builders
// below. The tenantId is mandatory for tenant-scoped data so we never share
// a key across tenants (RLS-bypass risk). Bumping CACHE_VERSION mass-busts
// every key without touching Redis.
const CACHE_NAMESPACE = "matgary";
const CACHE_ENV = process.env.NODE_ENV ?? "development";
const CACHE_VERSION = "v1";

export function tenantKey(tenantId: string, ...parts: (string | number)[]): string {
  return [
    CACHE_NAMESPACE,
    CACHE_ENV,
    CACHE_VERSION,
    "t",
    tenantId,
    ...parts.map(String),
  ].join(":");
}

export function globalKey(...parts: (string | number)[]): string {
  return [
    CACHE_NAMESPACE,
    CACHE_ENV,
    CACHE_VERSION,
    "g",
    ...parts.map(String),
  ].join(":");
}

const HIT_LOG = process.env.CACHE_DEBUG === "1";

function logHit(key: string) {
  if (HIT_LOG) console.log(`[cache] HIT  ${key}`);
}
function logMiss(key: string) {
  if (HIT_LOG) console.log(`[cache] MISS ${key}`);
}
function logErr(op: string, key: string, err: unknown) {
  console.warn(
    `[cache] ${op} failed for ${key}:`,
    err instanceof Error ? err.message : err,
  );
}

/**
 * Read a JSON value from cache. Returns null on miss, on error, or when Redis
 * isn't configured — the caller is expected to fall back to the source of
 * truth in those cases. Cache is opportunistic, never authoritative.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (raw == null) {
      logMiss(key);
      return null;
    }
    logHit(key);
    return JSON.parse(raw) as T;
  } catch (err) {
    logErr("get", key, err);
    return null;
  }
}

/** Store a JSON value with TTL (seconds). Errors are swallowed. */
export async function cacheSet<T>(key: string, value: T, ttlSec: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSec)));
  } catch (err) {
    logErr("set", key, err);
  }
}

/** Delete one or more keys. Errors are swallowed. */
export async function cacheDel(...keys: string[]): Promise<void> {
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    logErr("del", keys.join(","), err);
  }
}

/**
 * Get-or-load. The single-most-used helper: tries the cache, otherwise runs
 * `loader`, stores the result, and returns it. If Redis is down, just runs
 * the loader — the caller never has to handle cache failures.
 *
 *   const settings = await cacheRemember(
 *     tenantKey(tenantId, "settings"),
 *     300,
 *     () => loadFromDb(tenantId),
 *   );
 */
export async function cacheRemember<T>(
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await loader();
  // Don't cache nulls/undefineds — they're indistinguishable from a miss.
  if (value !== null && value !== undefined) {
    await cacheSet(key, value, ttlSec);
  }
  return value;
}

/**
 * Bust every key matching a prefix. Uses SCAN, not KEYS, so it's safe on a
 * busy Redis. Caller should pass a tight prefix; passing the bare namespace
 * would walk the entire keyspace.
 */
export async function cacheBustPrefix(prefix: string): Promise<void> {
  if (!redis) return;
  if (!prefix || prefix.length < 8) {
    // 8 covers "matgary:" — refuse anything shorter so a typo can't nuke
    // everything.
    console.warn(`[cache] refusing cacheBustPrefix("${prefix}") — too short`);
    return;
  }
  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 200 });
    const batch: string[] = [];
    for await (const keys of stream) {
      const arr = keys as string[];
      if (arr.length === 0) continue;
      batch.push(...arr);
      if (batch.length >= 500) {
        await redis.del(...batch.splice(0, batch.length));
      }
    }
    if (batch.length > 0) {
      await redis.del(...batch);
    }
  } catch (err) {
    logErr("bustPrefix", prefix, err);
  }
}

/** Bust everything cached for one tenant — use sparingly. */
export async function cacheBustTenant(tenantId: string): Promise<void> {
  await cacheBustPrefix(tenantKey(tenantId));
}
