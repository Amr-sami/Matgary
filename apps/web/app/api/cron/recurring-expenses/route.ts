import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { materializeDueRecurringExpenses } from "@/lib/repo/operations";
import { rateLimit } from "@/lib/ratelimit";
import { logActivity } from "@/lib/repo/activity";

// Periodic sweep that spawns any due recurring-expense child rows for every
// tenant. Designed to be poked by an external scheduler (the docker-compose
// `cron` sidecar, a host-level crontab, or a managed cron service) on the
// hour. Hourly cadence is overkill for monthly recurrences but cheap and
// gives ~1 h worst-case latency for "my electricity bill didn't appear yet"
// without us building a queue.
//
// Security model:
//   - Refuses without a CRON_SECRET in env (no implicit "open mode").
//   - Constant-time bearer-token compare against the Authorization header.
//   - POST only — GET is browsable / cacheable / loggable, POST is not.
//   - Rate-limited per source IP (6/h) so a leaked secret can't be used to
//     hammer the materialiser into thousands of spawns.
//   - 401 returned without leaking *why* it was rejected (missing vs wrong).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 6;
const RATE_WINDOW_SEC = 60 * 60;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim();
}

function checkSecret(provided: string | null): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) return false;
  if (!provided) return false;
  // Constant-time comparison guards against timing oracles. Buffers must be
  // identical length, so first compare lengths cheaply (still constant-time
  // because the early return doesn't depend on which bytes differ).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = await rateLimit("cron.recurring_expenses", ip, {
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  if (!checkSecret(bearerToken(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Fetch every tenant — there's no "active" flag today. If we add one later
  // (for cancelled/expired tenants we no longer want to bill or process),
  // filter here. Keeping the explicit `select` so a future column addition
  // doesn't accidentally widen the row.
  const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);

  const results: Array<{ tenantId: string; spawned: number }> = [];
  let totalSpawned = 0;
  let failures = 0;

  for (const t of rows) {
    try {
      const { spawned } = await materializeDueRecurringExpenses(t.id);
      results.push({ tenantId: t.id, spawned });
      totalSpawned += spawned;
      if (spawned > 0) {
        // Surface in the tenant's audit feed so an owner can see the system
        // (vs. a person) created the row.
        logActivity({
          tenantId: t.id,
          actorUserId: null,
          actorName: "نظام (جدولة)",
          action: "expense.recurring_materialized",
          category: "settings",
          metadata: { spawned },
        });
      }
    } catch (err) {
      failures += 1;
      // Don't abort the sweep on one tenant's failure.
      console.error(
        `[cron/recurring-expenses] tenant ${t.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    tenants: rows.length,
    totalSpawned,
    failures,
    // Per-tenant detail kept compact — useful for spot-checking but not
    // logged anywhere by default.
    results,
  });
}
