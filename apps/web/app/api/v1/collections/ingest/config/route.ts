import { NextRequest, NextResponse } from "next/server";
import { requireIngestDevice } from "@/lib/api/ingest-token";
import { handleRouteError } from "@/lib/collections/route-helpers";
import { ingestConfigFor } from "@/lib/repo/collection-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/collections/ingest/config (doc 15 spec 07 §4.5, §4.8; 03 §B.17).
// Ingest token, bucket `ingest.config` (60/h/device). The device-side filter:
// packages / senders of the device's accounts' providers, 06's keywords and
// OTP patterns, maxAgeHours 48, filterVersion, and configVersion (= the
// heartbeat's), so a filter fix reaches every phone without an app release.

export async function GET(req: NextRequest) {
  const auth = await requireIngestDevice(req, "ingest.config");
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await ingestConfigFor(auth.dev));
  } catch (err) {
    return handleRouteError(err, "GET /api/v1/collections/ingest/config");
  }
}
