// Login rate limiting. Reuses the project's sliding-window Redis limiter so
// the behavior matches the rest of the app (fail-open if Redis is down).

import { rateLimit } from "@/lib/ratelimit";

const PER_IP_LIMIT = 3;
const PER_IP_WINDOW_SEC = 15 * 60;       // 15 minutes
const GLOBAL_LIMIT = 30;
const GLOBAL_WINDOW_SEC = 5 * 60;        // 5 minutes
const GLOBAL_SCOPE_KEY = "global";

export interface LoginGateResult {
  ok: boolean;
  /** Earliest unix-ms at which an admitted attempt is possible again. */
  retryAfterMs?: number;
}

/** Spec §2.1: 3 failures per 15 min per IP + 30 per 5 min globally.
 *  When either bucket trips we return ok=false and the route should respond
 *  with 429 + a `Retry-After` header. */
export async function gateLoginAttempt(ip: string): Promise<LoginGateResult> {
  const [perIp, global] = await Promise.all([
    rateLimit("admin.login.ip", ip, {
      limit: PER_IP_LIMIT,
      windowSec: PER_IP_WINDOW_SEC,
    }),
    rateLimit("admin.login.global", GLOBAL_SCOPE_KEY, {
      limit: GLOBAL_LIMIT,
      windowSec: GLOBAL_WINDOW_SEC,
    }),
  ]);
  if (!perIp.ok || !global.ok) {
    const retryAt = Math.max(perIp.resetAt, global.resetAt);
    return { ok: false, retryAfterMs: retryAt };
  }
  return { ok: true };
}
