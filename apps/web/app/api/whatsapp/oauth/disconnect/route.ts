// POST /api/whatsapp/oauth/disconnect
//
// Logical disconnect — marks the active connection as 'disconnected' so
// outbound sending stops, but keeps the row for audit. Best-effort tries
// to unsubscribe our app from the tenant's WABA webhooks, but a failure
// there doesn't block the disconnect: a stale subscription is harmless,
// our send routes will refuse without an active connection regardless.

import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import {
  getActiveConnectionToken,
  markDisconnected,
} from "@/lib/whatsapp/connections";
import {
  readMetaConfig,
  unsubscribeAppFromWaba,
} from "@/lib/whatsapp/meta-graph";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const active = await getActiveConnectionToken(
    auth.ctx.tenantId,
    auth.ctx.branchId,
  );
  if (!active) {
    return NextResponse.json({ ok: true, alreadyDisconnected: true });
  }

  // Best-effort unsubscribe. Don't fail the request on a Graph error —
  // we still want the local disconnect to take effect.
  try {
    const cfg = readMetaConfig();
    if (cfg.appId && cfg.appSecret) {
      await unsubscribeAppFromWaba(cfg, active.conn.wabaId, active.token);
    }
  } catch (err) {
    logger.warn({
      event: "wa.oauth.unsubscribe_failed",
      tenantId: auth.ctx.tenantId,
      branchId: auth.ctx.branchId,
      wabaId: active.conn.wabaId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  await markDisconnected(
    auth.ctx.tenantId,
    auth.ctx.branchId,
    "user_disconnect",
  );

  logger.info({
    event: "wa.oauth.disconnected",
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    wabaId: active.conn.wabaId,
    phoneNumberId: active.conn.phoneNumberId,
  });

  return NextResponse.json({ ok: true });
}
