// Per-tenant API rate limit. Defends a tenant's own quota — a runaway
// integration or a leaked owner cookie can't take down the platform by
// hammering one route. Independent of the per-IP auth limits in
// `lib/auth.ts`.
//
// Usage from a route handler (after `requireTenant()` resolves):
//
//   const rl = await checkTenantRateLimit(r.ctx.tenantId, "products.list");
//   if (!rl.ok) return rl.response;
//
// Buckets follow `<resource>.<action>` naming. Add a new bucket here when
// you wire a new high-fan-in route — keeping them in one file lets ops
// tune limits in a single PR.

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { logger } from "@/lib/logger";

export interface TenantRateLimitBucket {
  /** Max requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/**
 * Bucket registry. The KEY is the scope passed in by callers; the VALUE is
 * the per-tenant limit applied.
 *
 * Defaults err on the loose side — these are SAFETY rails, not pricing
 * tiers. Tighten only after the metric "blocked: true" in the log shows
 * a real attacker / runaway client.
 */
const BUCKETS: Record<string, TenantRateLimitBucket> = {
  // Reads — generous; the cache absorbs most of these.
  "list.default": { limit: 120, windowSec: 60 },
  // Mutations — modest. Catches obvious abuse without blocking a busy POS.
  "write.default": { limit: 60, windowSec: 60 },
  // WhatsApp send. The existing tenant-wide WA bucket (30/min) lives
  // alongside this; this one is a guardrail in case that one is bypassed.
  "wa.send": { limit: 60, windowSec: 60 },
  // Reports & exports. Expensive queries; small per-minute budget.
  "reports.read": { limit: 30, windowSec: 60 },
};

function bucketFor(scope: string): TenantRateLimitBucket {
  return BUCKETS[scope] ?? BUCKETS["write.default"]!;
}

export interface AllowedTenantRateLimit {
  ok: true;
  count: number;
  resetAt: number;
}

export interface BlockedTenantRateLimit {
  ok: false;
  response: NextResponse;
}

/**
 * Consume one token in the named bucket for this tenant. Returns
 * `{ ok: false, response }` if the limit is hit so the caller can early-
 * return without further work.
 *
 * Redis-backed via `rateLimitConsume`. Fail-open: a Redis outage allows
 * the request through (the underlying limiter returns `{ ok: true }`)
 * because availability beats lockout when the platform's own infrastructure
 * is degraded.
 */
export async function checkTenantRateLimit(
  tenantId: string,
  scope: string,
): Promise<AllowedTenantRateLimit | BlockedTenantRateLimit> {
  const cfg = bucketFor(scope);
  const res = await rateLimit(`tenant.${scope}`, tenantId, {
    ...cfg,
    commit: true,
  });
  if (!res.ok) {
    logger.warn({
      event: "tenant.rate_limit.blocked",
      scope,
      tenantId,
      count: res.count,
      resetAt: res.resetAt,
    });
    const retryAfter = Math.max(1, Math.ceil((res.resetAt - Date.now()) / 1000));
    return {
      ok: false,
      response: NextResponse.json(
        { error: "RATE_LIMITED", scope, resetAt: res.resetAt },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(cfg.limit),
            "X-RateLimit-Reset": String(res.resetAt),
          },
        },
      ),
    };
  }
  return { ok: true, count: res.count, resetAt: res.resetAt };
}
