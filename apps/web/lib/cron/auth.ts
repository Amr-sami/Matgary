// Shared bearer-token + IP-rate-limit helpers for the `/api/cron/*` routes.
//
// Security model (copied from app/api/cron/recurring-expenses/route.ts —
// the canonical implementation kept inline there for historical reasons,
// duplicated here so newer cron endpoints don't drift):
//
//   - Refuses without a CRON_SECRET in env (no implicit "open mode").
//   - Constant-time bearer-token compare against the Authorization header.
//   - POST only — GET is browsable / cacheable / loggable, POST is not.
//   - Rate-limited per source IP so a leaked secret can't be used to
//     hammer the route into expensive work.
//   - 401 returned without leaking *why* it was rejected.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { rateLimit } from "@/lib/ratelimit";

export function clientIp(req: NextRequest): string {
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
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CronGuardOpts {
  /** Unique key for the rate-limit bucket per IP. Use the route name. */
  bucket: string;
  /** Calls per window per IP. Default 6. */
  limit?: number;
  /** Window in seconds. Default 1 hour. */
  windowSec?: number;
}

/** Returns a NextResponse if the request should be rejected; otherwise null
 *  meaning "proceed". Use at the top of every cron POST handler. */
export async function guardCronRequest(
  req: NextRequest,
  opts: CronGuardOpts,
): Promise<NextResponse | null> {
  const ip = clientIp(req);
  const limit = await rateLimit(opts.bucket, ip, {
    limit: opts.limit ?? 6,
    windowSec: opts.windowSec ?? 60 * 60,
  });
  if (!limit.ok) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  if (!checkSecret(bearerToken(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
