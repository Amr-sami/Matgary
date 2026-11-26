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
  // Digital collections L2 ingest (03 §B.4, 05 §4.15; called by spec 07).
  // `ingest.ip` is consumed BEFORE the token lookup (cheap refusal of token
  // guessing); `ingest.device` / `.heartbeat` / `.config` are keyed by the
  // ingest device id through checkScopedRateLimit; `ingest.default` is the
  // per-tenant ceiling through checkTenantRateLimit.
  "ingest.ip": { limit: 60, windowSec: 60 },
  "ingest.device": { limit: 120, windowSec: 60 },
  "ingest.default": { limit: 600, windowSec: 60 },
  "ingest.heartbeat": { limit: 12, windowSec: 3600 },
  "ingest.config": { limit: 60, windowSec: 3600 },
};

function bucketFor(scope: string): TenantRateLimitBucket {
  return BUCKETS[scope] ?? BUCKETS["write.default"]!;
}

/** The registered bucket for a scope, or undefined (callers of the check
 *  functions fall back to `write.default`). Read-only view for tests/ops. */
export function rateLimitBucket(scope: string): Readonly<TenantRateLimitBucket> | undefined {
  const b = BUCKETS[scope];
  return b ? { ...b } : undefined;
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
  return consume(scope, tenantId, { tenantId });
}

/**
 * `checkTenantRateLimit` with a free identifier instead of the tenant id —
 * a client IP (`ingest.ip`, before the ingest token is looked up) or an
 * ingest device id (`ingest.device`, `ingest.heartbeat`, `ingest.config`).
 * Same Redis key family (`rl:tenant.<scope>:<identifier>`), same 429 body
 * `{error:"RATE_LIMITED", scope, resetAt}` + Retry-After, same
 * TENANT_RATE_LIMIT_DISABLED escape hatch, same fail-open.
 */
export async function checkScopedRateLimit(
  scope: string,
  identifier: string,
): Promise<AllowedTenantRateLimit | BlockedTenantRateLimit> {
  return consume(scope, identifier, { identifier });
}

async function consume(
  scope: string,
  identifier: string,
  logFields: { tenantId: string } | { identifier: string },
): Promise<AllowedTenantRateLimit | BlockedTenantRateLimit> {
  // Escape hatch for the load-test rig (Phase 5A). NEVER set in production.
  // The per-tenant limiter is a safety rail against runaway clients, not a
  // pricing tier — but driving sustained load against it from one tenant
  // is exactly what the rig does, so we honour the env flag.
  if (process.env.TENANT_RATE_LIMIT_DISABLED === "1") {
    return { ok: true, count: 0, resetAt: Date.now() + 60_000 };
  }
  const cfg = bucketFor(scope);
  const res = await rateLimit(`tenant.${scope}`, identifier, {
    ...cfg,
    commit: true,
  });
  if (!res.ok) {
    logger.warn({
      event: "tenant.rate_limit.blocked",
      scope,
      ...logFields,
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
