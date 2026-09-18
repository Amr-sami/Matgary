import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireTenant } from "@/lib/api/auth-helpers";
import { bearerFromHeader, verifyAccessToken } from "@/lib/api/native-token";
import { revokeDeviceLineage } from "@/lib/api/native-devices";

// The "your devices" screen: what is signed in, and a kill switch for each.
//
// This is the user-facing half of why refresh tokens are per-device rows at
// all. `users.token_version` can only express "sign out everywhere"; a lost
// handset needs "sign out THAT one", which is what DELETE here does.
//
// The refresh token hash NEVER leaves the database — it is a credential
// equivalent, and this endpoint is reachable from the phone that lost it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DeviceRow {
  id: string;
  device_name: string | null;
  platform: string | null;
  app_version: string | null;
  install_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
}

/** The device id of the caller's own access token, so the list can mark it.
 *  Null for a cookie session — the web has no device row to point at. */
async function callerDeviceId(h: Headers): Promise<string | null> {
  const bearer = bearerFromHeader(h.get("authorization"));
  if (!bearer) return null;
  const claims = await verifyAccessToken(bearer);
  return claims?.did || null;
}

export async function GET() {
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;

  const currentDeviceId = await callerDeviceId(await headers());

  // Scoped by user_id AND tenant_id: user_id is the real ownership boundary
  // (auth_devices is bootstrap state and carries no RLS policy), tenant_id is
  // belt-and-braces so a membership move can never surface another tenant's
  // sessions.
  const rows = (await db.execute(sql`
    SELECT id, device_name, platform, app_version, install_id,
           created_at, last_used_at, expires_at
      FROM auth_devices
     WHERE user_id = ${auth.ctx.userId}
       AND tenant_id = ${auth.ctx.tenantId}
       AND revoked_at IS NULL
       AND expires_at > now()
     ORDER BY created_at DESC
  `)) as unknown as DeviceRow[];

  return NextResponse.json({
    devices: rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      platform: r.platform,
      appVersion: r.app_version,
      // The stable handle for a device: `id` rotates on every refresh,
      // install_id survives it. The client keys lineages on this.
      installId: r.install_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      current: r.id === currentDeviceId,
    })),
  });
}

export async function DELETE(req: Request) {
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;

  const parsed = z
    .string()
    .uuid()
    .safeParse(new URL(req.url).searchParams.get("id"));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_DEVICE_ID" }, { status: 400 });
  }

  // This tombstone IS the per-device revocation: the row can never refresh
  // again (lib/api/native-token.ts `judgeRefresh` → "revoked"). What it does
  // NOT do is invalidate the access token the device currently holds — those
  // are verified statelessly, so the device keeps working for the remaining
  // life of that token, at most ACCESS_TTL_SEC (15 minutes), and is refused
  // at its next refresh. Documented, accepted: the alternative is a database
  // read on every authenticated request.
  //
  // The id the user tapped is the row the list showed — and a row's id
  // rotates on every refresh the device performs. `revokeDeviceLineage`
  // therefore revokes the LIVE head of that device's lineage (same install_id,
  // or the end of the replaced_by_id chain), not just the tapped id, so a
  // refresh that landed between the list and the tap cannot turn this into a
  // silent no-op. The body names what was actually tombstoned.
  //
  // Re-revoking a device the user already revoked still reads as success
  // (404 would be a lie); a tapped id that rotated with nothing live behind
  // it is 409 DEVICE_ROTATED, the cue for the client to re-list rather than
  // trust a stale row.
  const result = await revokeDeviceLineage(auth.ctx.userId, parsed.data);
  switch (result.kind) {
    case "revoked":
      return NextResponse.json({
        ok: true,
        revokedId: result.ids[0],
        revokedIds: result.ids,
      });
    case "already_revoked":
      return NextResponse.json({ ok: true, revokedId: parsed.data, revokedIds: [] });
    case "rotated":
      return NextResponse.json({ error: "DEVICE_ROTATED" }, { status: 409 });
    case "not_found":
      return NextResponse.json({ error: "DEVICE_NOT_FOUND" }, { status: 404 });
  }
}
