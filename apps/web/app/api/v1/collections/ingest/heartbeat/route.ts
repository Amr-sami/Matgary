import { NextRequest, NextResponse } from "next/server";
import { requireIngestDevice } from "@/lib/api/ingest-token";
import { heartbeatSchema } from "@/lib/collections/credit-schemas";
import { errorResponse, handleRouteError, invalidRequest } from "@/lib/collections/route-helpers";
import { recordHeartbeat } from "@/lib/repo/collection-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/collections/ingest/heartbeat (doc 15 spec 07 §4.5, §4.8).
// Ingest token, bucket `ingest.heartbeat` (12/h/device). `platform` must be
// the device's own. → 200 {configVersion}: the phone refetches the config
// only when it changes. Never touches last_message_at (silence is about
// messages).

export async function POST(req: NextRequest) {
  const auth = await requireIngestDevice(req, "ingest.heartbeat");
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null);
  const parsed = heartbeatSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  if (parsed.data.platform !== auth.dev.platform) {
    return errorResponse("INVALID_REQUEST", 400, { path: "platform", message: "not this device's platform" });
  }
  try {
    const { v: _v, ...beat } = parsed.data;
    return NextResponse.json(await recordHeartbeat(auth.dev, beat));
  } catch (err) {
    return handleRouteError(err, "POST /api/v1/collections/ingest/heartbeat");
  }
}
