import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireTenant } from "@/lib/api/auth-helpers";
import { bearerFromHeader, verifyAccessToken } from "@/lib/api/native-token";

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
    SELECT id, device_name, platform, app_version,
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

  // COALESCE rather than `WHERE revoked_at IS NULL`: revoking a device the
  // user already revoked must still read as success (404 would be a lie), but
  // the original revoke reason and timestamp are preserved.
  //
  // Scoped by user_id, so a device id belonging to anyone else matches nothing
  // and is reported as not found — the same answer a made-up id gets, which is
  // what keeps this from confirming that some other user's device exists.
  const revoked = (await db.execute(sql`
    UPDATE auth_devices
       SET revoked_at     = COALESCE(revoked_at, now()),
           revoked_reason = COALESCE(revoked_reason, 'user_revoked')
     WHERE id = ${parsed.data}
       AND user_id = ${auth.ctx.userId}
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  if (revoked.length === 0) {
    return NextResponse.json({ error: "DEVICE_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
