import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { cleanupIdleDemoClones } from "@/lib/demo/clone-tenant";
import { rateLimit } from "@/lib/ratelimit";

// Sweep ephemeral demo tenants that nobody's touched for the idle window.
// Visitors who close the tab without clicking "خروج" would otherwise leave
// their clone behind; the sweep keeps the tenants table from accreting
// abandoned tenants.
//
// Auth: same Bearer-CRON_SECRET pattern as the other cron routes here.
// Schedule it from the platform cron (Vercel Cron, k8s CronJob, etc) every
// 30-60 min. Defaults to 1h idle TTL; pass ?idleMinutes=N to override.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 6;
const RATE_WINDOW_SEC = 60 * 60;
const DEFAULT_IDLE_MINUTES = 60;
const MIN_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 24 * 60;

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

function resolveIdleMinutes(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("idleMinutes");
  if (!raw) return DEFAULT_IDLE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_IDLE_MINUTES;
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, Math.floor(n)));
}

export async function POST(req: NextRequest) {
  const rl = await rateLimit("cron.demo-cleanup", clientIp(req), {
    limit: RATE_LIMIT,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  if (!checkSecret(bearerToken(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const idleMinutes = resolveIdleMinutes(req);
  const deleted = await cleanupIdleDemoClones(idleMinutes * 60 * 1000);
  return NextResponse.json({ ok: true, deleted, idleMinutes });
}
