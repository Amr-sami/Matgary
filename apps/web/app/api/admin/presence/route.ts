// GET /api/admin/presence
// Platform-wide presence snapshot (online now, 5m, 15m, today, DAU, WAU, MAU,
// platform split). Exact counts. Cheap to call — it's one Promise.all of
// aggregate queries. Not cached — the UI polls this at its own cadence.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { getPlatformPresence } from "@/lib/admin/presence-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const snapshot = await getPlatformPresence();
  return NextResponse.json(snapshot);
}
