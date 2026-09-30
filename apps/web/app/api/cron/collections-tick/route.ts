import { NextRequest, NextResponse } from "next/server";
import { guardCronRequest } from "@/lib/cron/auth";
import { logger } from "@/lib/logger";
import { runCollectionsTick } from "@/lib/repo/collections-tick";

// Digital collections tick (mobile-dev-docs/15-digital-collections/13 §4.10,
// 03 §B.7). Pinned to */15 in the compose cron service (spec 16): 5 pokes per
// sliding hour, inside guardCronRequest's default 6/h per IP.
//   M1: staleSweep (grouped stale alerts) · limitSweep (wallet limit warnings)
//   M2 (13-C, with spec 07): silentSourceSweep · rawPurge · lateRematch
// The JSON result is printed by the cron sidecar into /var/log/cron.log and
// monitored by spec 16 (`truncated`, `ms`, `failures`).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = await guardCronRequest(req, { bucket: "collections-tick" });
  if (blocked) return blocked;
  const result = await runCollectionsTick({ now: new Date() });
  logger.info({ event: "cron.collections_tick", ...result });
  return NextResponse.json({ ok: true, ...result });
}
