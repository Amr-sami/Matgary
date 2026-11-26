import { redis } from "./redis";
import { globalKey } from "./cache";

// Sliding-window rate limiter implemented on Redis sorted sets. For each
// (scope, identifier) we keep a ZSET of attempt timestamps; on every check
// we drop entries older than the window, count what's left, and add the
// current attempt if we're admitting it.
//
// Atomic in a single Lua script so a burst of concurrent requests can't slip
// past the limit. Fail-open: if Redis is unreachable, the limiter returns
// `{ ok: true }` so a Redis outage can't lock everyone out — the price of
// availability over a few unrate-limited seconds.

const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local commit = ARGV[4] == "1"

redis.call("ZREMRANGEBYSCORE", key, 0, now - window_ms)
local count = redis.call("ZCARD", key)
if count >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local resetAt = tonumber(oldest[2]) + window_ms
  return { 0, count, resetAt }
end
if commit then
  -- Use the timestamp as both score and member; collisions in the same ms
  -- are vanishingly rare and harmless (one would just overwrite).
  redis.call("ZADD", key, now, tostring(now) .. ":" .. tostring(math.random(1, 1e9)))
  redis.call("PEXPIRE", key, window_ms)
end
return { 1, count + (commit and 1 or 0), now + window_ms }
`;

export interface RateLimitResult {
  ok: boolean;
  /** Number of attempts already counted in the current window. */
  count: number;
  /** Unix ms when the oldest counted attempt expires (i.e. when one slot frees). */
  resetAt: number;
}

export interface RateLimitOptions {
  /** Max attempts permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /**
   * If true (default), a successful check counts the current attempt against
   * the budget. Set to false for a "peek" — useful when you only want to
   * commit failed attempts (e.g. login: increment only on bad password).
   */
  commit?: boolean;
}

/**
 * Check (and optionally consume) one attempt against a sliding window.
 *
 * Example:
 *   const r = await rateLimit("login.ip", clientIp, { limit: 10, windowSec: 900 });
 *   if (!r.ok) return tooMany();
 */
export async function rateLimit(
  scope: string,
  identifier: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = opts.windowSec * 1000;
  const commit = opts.commit !== false;

  if (!redis) {
    // Fail-open. Return a result that looks "permitted" without ever
    // suggesting we're tracking the user — so callers don't surprise-deny.
    return { ok: true, count: 0, resetAt: now + windowMs };
  }

  const key = globalKey("rl", scope, identifier);
  try {
    const res = (await redis.eval(
      SCRIPT,
      1,
      key,
      String(now),
      String(windowMs),
      String(opts.limit),
      commit ? "1" : "0",
    )) as [number, number, number];
    return {
      ok: res[0] === 1,
      count: res[1],
      resetAt: res[2],
    };
  } catch (err) {
    console.warn(
      "[ratelimit] eval failed, failing open:",
      err instanceof Error ? err.message : err,
    );
    return { ok: true, count: 0, resetAt: now + windowMs };
  }
}

/**
 * Manually consume one attempt (used after we've already determined an
 * attempt was bad — e.g. wrong password). Always commits, never asks the
 * "would this be allowed" question.
 */
export async function rateLimitConsume(
  scope: string,
  identifier: string,
  opts: Omit<RateLimitOptions, "commit">,
): Promise<void> {
  await rateLimit(scope, identifier, { ...opts, commit: true });
}
