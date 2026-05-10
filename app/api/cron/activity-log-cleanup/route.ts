import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { pruneActivityAllTenants } from "@/lib/repo/activity";
import { rateLimit } from "@/lib/ratelimit";

// Daily retention sweep for activity_logs. The audit table is otherwise
// append-only and grows forever; without partitioning, we just delete rows
// older than ACTIVITY_LOG_RETENTION_DAYS. Default is 730 days = 2 years,
// which matches Egypt's PDPL (Law 151/2020) reasonable-retention guidance.
//
// Same auth model as the other cron routes:
//   - Bearer token from CRON_SECRET, timingSafeEqual
//   - POST only
//   - Per-IP rate limit
//
// Note: this is a stop-gap. Once any single tenant pushes the table past a
// few hundred GB, swap to native PG partitioning (PARTITION BY RANGE
// (created_at)) — see task.md "Activity log retention" backlog item.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 6;
const RATE_WINDOW_SEC = 60 * 60;
const DEFAULT_RETENTION_DAYS = 730;

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
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveRetentionDays(): number {
  const raw = process.env.ACTIVITY_LOG_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  // Clamp to 30..3650 so a fat-fingered env var can't accidentally nuke
  // every audit row (or keep them so long the table is useless).
  return Math.max(30, Math.min(3650, Math.floor(n)));
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = await rateLimit("cron.activity_cleanup", ip, {
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  if (!checkSecret(bearerToken(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const retentionDays = resolveRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await pruneActivityAllTenants(cutoff);

  return NextResponse.json({
    ok: true,
    retentionDays,
    cutoff: cutoff.toISOString(),
    ...result,
  });
}
