import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { executePendingDeletions } from "@/lib/repo/tenant-deletion";
import { rateLimit } from "@/lib/ratelimit";

// H12 — daily sweep that hard-deletes any tenant past its
// deletion_scheduled_at. Same security envelope as the other cron routes:
//
//   - Refuses without CRON_SECRET in env (no implicit open mode).
//   - Constant-time bearer compare against the Authorization header.
//   - POST only.
//   - IP-rate-limited (6 / h) to neuter a leaked secret.
//
// Designed to be poked once per day at 03:00 UTC by the compose `cron`
// sidecar.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_RL_LIMIT = 6;
const CRON_RL_WINDOW_SEC = 60 * 60;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function constantTimeMatch(provided: string, secret: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return unauthorized();
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m || !constantTimeMatch(m[1]!.trim(), secret)) return unauthorized();

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    "unknown";
  const rl = await rateLimit("cron.tenant_deletion", ip, {
    limit: CRON_RL_LIMIT,
    windowSec: CRON_RL_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const result = await executePendingDeletions();
  return NextResponse.json({ ok: true, purged: result.purged });
}
