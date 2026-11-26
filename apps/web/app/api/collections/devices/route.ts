import { NextRequest, NextResponse } from "next/server";
import { requirePermissionWithBranchEnforced } from "@/lib/api/auth-helpers";
import { resolveCollectionsFeatures } from "@/lib/collections/flags";
import { deviceCreateSchema } from "@/lib/collections/credit-schemas";
import { accessibleBranches, errorResponse, handleRouteError, invalidRequest } from "@/lib/collections/route-helpers";
import { isOwner } from "@/lib/permissions";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  IDEMPOTENCY_MISMATCH_BODY,
  lookupIdempotent,
  rememberResponse,
  requestFingerprint,
  validateIdempotencyKey,
} from "@/lib/api/idempotency";
import { appOrigin } from "@/lib/url-safe";
import { logActivity } from "@/lib/repo/activity";
import {
  MAX_LIVE_DEVICES,
  createIngestDevice,
  ingestUrls,
  listIngestDevices,
  replayCreatedDevice,
  type DeviceDTO,
} from "@/lib/repo/collection-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/collections/devices → {devices, maxDevices: 10} — live + revoked
//      in the last 30 days, newest first. Never flag-gated (D07-2: a device
//      must stay listable and revocable after the ingest flag is turned off).
// POST /api/collections/devices → 201 {device, token, ingestUrl, heartbeatUrl,
//      configUrl}; the token is shown ONCE (doc 15 spec 07 §4.5, §4.11).
//      Gated by features.collectionsIngest. Optional Idempotency-Key: the
//      replay entry never holds the token — a replay before first use re-mints
//      it for the same device (the previous one stops working), after first
//      use it answers token: null.

export async function GET() {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "list.default");
  if (!rl.ok) return rl.response;
  try {
    const devices = await listIngestDevices(r.ctx.tenantId);
    return NextResponse.json({ devices, maxDevices: MAX_LIVE_DEVICES });
  } catch (err) {
    return handleRouteError(err, "GET /api/collections/devices");
  }
}

export async function POST(req: NextRequest) {
  const r = await requirePermissionWithBranchEnforced("manage_collection_accounts");
  if (!r.ok) return r.response;
  const features = await resolveCollectionsFeatures(r.ctx.tenantId, r.ctx.branchId);
  if (!features.collections) return errorResponse("COLLECTIONS_DISABLED", 403);
  if (!features.collectionsIngest) return errorResponse("INGEST_DISABLED", 403);

  const body = await req.json().catch(() => ({}));
  const rawKey = req.headers.get("Idempotency-Key");
  const key = validateIdempotencyKey(rawKey);
  if (rawKey && !key) return NextResponse.json({ error: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const fingerprint = requestFingerprint(r.ctx.userId, { op: "collection.device_create", body });
  if (key) {
    const hit = await lookupIdempotent(r.ctx.tenantId, key, fingerprint);
    if (hit.kind === "mismatch") return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
    if (hit.kind === "replay") {
      const cached = hit.cached.body as { device: DeviceDTO };
      const again = cached?.device?.id ? await replayCreatedDevice(r.ctx.tenantId, cached.device.id) : null;
      if (!again) return NextResponse.json(hit.cached.body, { status: hit.cached.status });
      return NextResponse.json({ ...(hit.cached.body as object), device: again.device, token: again.token }, { status: 201 });
    }
  }

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const parsed = deviceCreateSchema.safeParse(body ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const d = parsed.data;
    const created = await createIngestDevice(
      {
        tenantId: r.ctx.tenantId,
        userId: r.ctx.userId,
        isOwner: isOwner(r.ctx),
        accessibleBranchIds: accessibleBranches(r.ctx),
      },
      {
        label: d.label,
        platform: d.platform,
        channels: d.channels,
        accountIds: d.accountIds,
        branchId: d.branchId ?? null,
        consentVersion: d.consentVersion,
        appVersion: d.appVersion ?? null,
        osVersion: d.osVersion ?? null,
        replacesDeviceId: d.replacesDeviceId ?? null,
      },
    );
    const urls = ingestUrls(appOrigin(req));
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "collection.device_create",
      category: "collection",
      entityType: "collection_device",
      entityId: created.device.id,
      entityLabel: created.device.label,
      branchId: created.device.branchId,
      metadata: {
        platform: created.device.platform,
        channels: created.device.channels,
        accountCount: created.device.accountIds.length,
        tokenPrefix: created.device.tokenPrefix,
        ...(created.replacedDeviceId ? { replacedDeviceId: created.replacedDeviceId } : {}),
      },
    });
    if (created.replacedDeviceId) {
      logActivity({
        tenantId: r.ctx.tenantId,
        actorUserId: r.ctx.userId,
        action: "collection.device_revoke",
        category: "collection",
        entityType: "collection_device",
        entityId: created.replacedDeviceId,
        metadata: { reason: "replaced", replacedBy: created.device.id },
      });
    }
    // The replay entry NEVER holds the plaintext token (§4.11, criterion 20).
    if (key) await rememberResponse(r.ctx.tenantId, key, 201, { device: created.device, token: null, ...urls }, fingerprint);
    return NextResponse.json({ device: created.device, token: created.token, ...urls }, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "POST /api/collections/devices");
  }
}
