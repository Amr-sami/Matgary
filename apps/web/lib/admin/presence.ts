// Phase 2 — Real-time presence, canonical constants, and timezone semantics
// for platform-wide active-user analytics.
//
// Design (approved):
//
//   • ONE online window (5 minutes) used everywhere. Canonical constant
//     exported from this module. No other file is allowed to redefine it.
//   • ONE reporting timezone, configurable via STORO_REPORTING_TZ, default
//     Africa/Cairo for the current deployment. DAU/WAU/MAU buckets use it
//     consistently across platform-wide AND per-tenant endpoints.
//   • Heartbeat is driven by the existing authenticated request chokepoint
//     (`requireTenant()` → `touchHeartbeat()`) with a 60-second write
//     throttle enforced as a conditional `UPDATE … WHERE last < now - 60s`.
//     Never updates on every request; never trusts client-supplied user_id
//     or tenant_id.
//   • Mobile presence → `auth_devices.last_used_at` (the column already
//     exists; Phase 2 just starts writing it).
//   • Web presence → `web_live_sessions` (new table, one row per user).
//   • Platform tagging: mobile is authoritative (`auth_devices.platform`);
//     web is classified from the User-Agent (web / other). Analytics only —
//     never used for authorisation.
//
// Non-goals: no in-memory presence cache — the DB UPDATE is itself the
// throttle and runs in <1 ms. No Redis presence set. No sub-minute beats.

import { sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";

// ─── Canonical constants ────────────────────────────────────────────────────

/** A user is "online" when their last recorded activity was within this
 *  window. Changing it changes every presence KPI atomically — do not copy
 *  the literal elsewhere. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** How often the heartbeat is allowed to write. Below this interval every
 *  authenticated request short-circuits the DB UPDATE. Measured from the
 *  prior successful UPDATE on the same row. */
export const HEARTBEAT_THROTTLE_MS = 60 * 1000;

/** Secondary presence windows displayed on the Overview Command Center. */
export const ACTIVE_5M_MS = 5 * 60 * 1000;
export const ACTIVE_15M_MS = 15 * 60 * 1000;

/**
 * The SINGLE reporting timezone used across all platform-wide and
 * per-tenant DAU/WAU/MAU calculations.
 *
 * Deliberately NOT per-tenant.timezone — mixing two bucket definitions
 * ("today" means different things on two screens) was the exact trap the
 * stabilization brief warned against. Configurable via env so a future
 * market (e.g. a GCC region) can override without a schema change.
 *
 * Storage is always UTC (postgres `timestamptz`). This constant only
 * affects *reporting* — where day/week/month boundaries fall.
 */
export const REPORTING_TZ =
  process.env.STORO_REPORTING_TZ && process.env.STORO_REPORTING_TZ.trim().length > 0
    ? process.env.STORO_REPORTING_TZ.trim()
    : "Africa/Cairo";

/**
 * Canonical active-user window semantics.
 *
 *   DAU   distinct users with ≥1 activity in the calendar day defined by
 *         REPORTING_TZ. Boundaries: [today_start_in_tz, next_day_start_in_tz).
 *         "Today" always means today in the reporting timezone.
 *   WAU   distinct users with ≥1 activity in the rolling 7-day window
 *         ending NOW. Boundaries: (now − 7 days, now]. Rolling in UTC
 *         because 7×24h is an exact duration regardless of TZ — the TZ
 *         only matters for calendar-day cuts.
 *   MAU   distinct users with ≥1 activity in the rolling 30-day window
 *         ending NOW. Same convention as WAU.
 *
 * "Activity" = (a) an `activity_logs` row written for that user in the
 * window, OR (b) a presence heartbeat (`web_live_sessions.last_activity_at`
 * or `auth_devices.last_used_at`) in the window. The union is deduplicated
 * on user_id.
 */
export type ActivePeriod = "day" | "week" | "month";

// ─── Transport descriptor passed from requireTenant ─────────────────────────

/**
 * Identifies which presence row the heartbeat should touch:
 *   { transport: "bearer" }  → mobile, update auth_devices.last_used_at
 *                              where id = deviceId
 *   { transport: "cookie" }  → web, UPSERT web_live_sessions keyed by userId
 *
 * The caller (`requireTenant`) fills this from server-verified identity
 * only. The client never supplies user_id / tenant_id directly.
 */
export type HeartbeatTransport =
  | { kind: "bearer"; deviceId: string | null }
  | { kind: "cookie"; userAgent: string | null };

// ─── UA → platform classifier (web only) ────────────────────────────────────

/**
 * Classifies a browser User-Agent into one of the admin analytics buckets.
 *
 * Mobile UAs (iOS/Android native apps) never reach this — the native
 * client sends a bearer token and we read `auth_devices.platform`
 * directly. This function is for the web transport. Anything the parser
 * cannot confidently bucket stays "other" (e.g. curl, uptime monitors,
 * server-to-server pings). We deliberately do NOT force every unknown UA
 * into "web" — that would inflate the web-active count with bots.
 */
export function classifyWebPlatform(userAgent: string | null): "web" | "other" {
  if (!userAgent) return "other";
  const ua = userAgent.toLowerCase();
  // Reject common automation/monitoring agents.
  if (
    ua.includes("curl") ||
    ua.includes("wget") ||
    ua.includes("bot") ||
    ua.includes("spider") ||
    ua.includes("crawler") ||
    ua.includes("uptimerobot") ||
    ua.startsWith("go-http-client") ||
    ua.startsWith("node") ||
    ua.startsWith("python-")
  ) {
    return "other";
  }
  // The usual browser signatures. "Mozilla" is a legacy string sent by
  // every major browser; combining it with a recognisable engine keeps the
  // false-positive rate negligible.
  if (
    ua.includes("mozilla") &&
    (ua.includes("safari") ||
      ua.includes("firefox") ||
      ua.includes("chrome") ||
      ua.includes("edg/") ||
      ua.includes("opr/"))
  ) {
    return "web";
  }
  return "other";
}

// ─── Heartbeat writer ───────────────────────────────────────────────────────

/**
 * Update the presence row for an authenticated user. Called once per
 * authenticated request from `requireTenant`. Returns quickly (<1 ms in the
 * no-op path) and NEVER throws into the request path.
 *
 *   Mobile (bearer with a device id):
 *     UPDATE auth_devices SET last_used_at = now()
 *     WHERE id = $did AND (last_used_at IS NULL OR last_used_at < now()-60s)
 *
 *   Web (cookie):
 *     INSERT INTO web_live_sessions (…)
 *     ON CONFLICT (user_id) DO UPDATE SET last_activity_at = now(), …
 *     WHERE web_live_sessions.last_activity_at < now()-60s
 *
 * Both paths are a single statement — PostgreSQL enforces the throttle
 * atomically across concurrent requests. No in-memory cache, no race.
 */
export async function touchHeartbeat(
  userId: string,
  tenantId: string,
  transport: HeartbeatTransport,
): Promise<void> {
  try {
    if (transport.kind === "bearer") {
      if (!transport.deviceId) return;
      // withTenant sets the per-tx GUC so any RLS policy on auth_devices
      // sees a valid tenant. The UPDATE is still PK-scoped — server
      // identity is the only authority.
      await withTenant(tenantId, (tx) =>
        tx.execute(sql`
          UPDATE auth_devices
          SET last_used_at = now()
          WHERE id = ${transport.deviceId}
            AND user_id = ${userId}
            AND revoked_at IS NULL
            AND (
              last_used_at IS NULL
              OR last_used_at < now() - INTERVAL '60 seconds'
            )
        `),
      );
      return;
    }
    const platform = classifyWebPlatform(transport.userAgent);
    const uaTrimmed = (transport.userAgent ?? "").slice(0, 255);
    await withTenant(tenantId, (tx) =>
      tx.execute(sql`
        INSERT INTO web_live_sessions (user_id, tenant_id, platform, user_agent, last_activity_at)
        VALUES (${userId}, ${tenantId}, ${platform}, ${uaTrimmed}, now())
        ON CONFLICT (user_id) DO UPDATE
        SET last_activity_at = now(),
            tenant_id = EXCLUDED.tenant_id,
            platform = EXCLUDED.platform,
            user_agent = EXCLUDED.user_agent
        WHERE web_live_sessions.last_activity_at < now() - INTERVAL '60 seconds'
      `),
    );
  } catch {
    // Presence is best-effort. A DB blip must NEVER break an authenticated
    // request. Silent failure is intentional; the next hit from the same
    // user will re-attempt.
  }
}
