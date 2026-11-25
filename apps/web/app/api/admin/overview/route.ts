import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/permissions";
import { getOverview } from "@/lib/admin/overview";
import { getAttentionDigest } from "@/lib/admin/store-health";
import {
  getDeviceAnalytics,
  getPlatformPresence,
  getStoreActivityDigest,
} from "@/lib/admin/presence-analytics";
import { getPlatformAggregates } from "@/lib/admin/tenant-counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("tenant.read");
  if (!r.ok) return r.response;
  const [
    payload,
    attention,
    presence,
    devices,
    storeActivity,
    aggregates,
  ] = await Promise.all([
    getOverview(),
    getAttentionDigest(),
    getPlatformPresence(),
    getDeviceAnalytics(),
    getStoreActivityDigest(),
    getPlatformAggregates(),
  ]);
  return NextResponse.json({
    ...payload,
    attention,
    presence,
    devices,
    storeActivity,
    aggregates,
  });
}
