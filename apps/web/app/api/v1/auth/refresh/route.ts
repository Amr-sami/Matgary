import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { resolveTenantContext } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/ratelimit";
import {
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  bearerFromHeader,
  hashRefreshToken,
  mintRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "@/lib/api/native-token";

// Native token refresh, with ROTATION + REUSE DETECTION.
//
// Every successful refresh burns the presented token and mints a new one, and
// the burnt row keeps a pointer (`replaced_by_id`) to its successor. That
// pointer is the whole trick: a refresh token lives on a handset we do not
// control, so the only signal we will ever get that it leaked is the *original
// owner and the thief both using it*. One of them presents a token that has
// already been rotated — a row that is revoked AND has a successor — and that
// can only happen if two parties hold the same secret. We cannot tell which
// one is the thief, so we kill the whole chain and make both sign in again.
// Without this, a stolen refresh token is silently valid for 90 days.
//
// The new access token is minted from a FRESH `resolveTenantContext`, not from
// the old claims, so a permission change, a suspension or a lapsed
// subscription takes hold on the next refresh (<= 15 minutes) instead of
// riding along until the device signs in again.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // Length range only — the token is opaque base64url from mintRefreshToken().
  refreshToken: z.string().min(20).max(500),
});

interface DeviceRow {
  id: string;
  user_id: string;
  tenant_id: string;
  device_name: string | null;
  platform: string | null;
  app_version: string | null;
  install_id: string | null;
  created_at: Date;
  replaced_by_id: string | null;
  revoked: boolean;
  expired: boolean;
}

function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() ?? "unknown";
}

export async function POST(req: Request) {
  const h = await headers();

  // A refresh is cheap for the client and involves a DB lookup for us; cap it
  // so a stolen-token guessing loop (or a client stuck in a retry storm)
  // cannot hammer the table. Generous enough that a normal device — one
  // refresh per 15 minutes — never comes close.
  const limited = await rateLimit("auth.refresh.ip", clientIp(h), {
    limit: 60,
    windowSec: 300,
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  // Look the row up by hash: the plaintext is never stored, so this is the
  // only way to find it, and it is a unique-index probe.
  const presentedHash = hashRefreshToken(body.refreshToken);
  const [row] = (await db.execute(sql`
    SELECT id, user_id, tenant_id, device_name, platform, app_version,
           install_id, created_at, replaced_by_id,
           (revoked_at IS NOT NULL) AS revoked,
           (expires_at <= now())    AS expired
      FROM auth_devices
     WHERE refresh_token_hash = ${presentedHash}
     LIMIT 1
  `)) as unknown as DeviceRow[];

  if (!row) {
    return NextResponse.json(
      { error: "INVALID_REFRESH_TOKEN" },
      { status: 401 },
    );
  }

  // Revoked AND superseded == this token was already rotated, yet someone
  // still holds it. Two parties have the secret. Kill every live session this
  // user has rather than guessing which one is legitimate.
  if (row.revoked && row.replaced_by_id) {
    await db.execute(sql`
      UPDATE auth_devices
         SET revoked_at = now(), revoked_reason = 'token_reuse'
       WHERE user_id = ${row.user_id}
         AND revoked_at IS NULL
    `);
    logger.warn({
      event: "native_auth.refresh_reuse_detected",
      userId: row.user_id,
      tenantId: row.tenant_id,
      deviceId: row.id,
      installId: row.install_id,
    });
    return NextResponse.json(
      { error: "TOKEN_REUSE_DETECTED" },
      { status: 401 },
    );
  }

  // Revoked without a successor is an ordinary dead token — logout, a device
  // the user revoked, a reinstall. Nothing suspicious, nothing to escalate.
  if (row.revoked) {
    return NextResponse.json(
      { error: "INVALID_REFRESH_TOKEN" },
      { status: 401 },
    );
  }

  if (row.expired) {
    // Tombstone it so the "your devices" list stops showing a session that can
    // never be used again.
    await db.execute(sql`
      UPDATE auth_devices
         SET revoked_at = now(), revoked_reason = 'expired'
       WHERE id = ${row.id} AND revoked_at IS NULL
    `);
    return NextResponse.json(
      { error: "INVALID_REFRESH_TOKEN" },
      { status: 401 },
    );
  }

  // Live context, not the claims the old token carried — see the header note.
  const ctx = await resolveTenantContext(row.user_id);
  if (!ctx.tenantId) {
    return NextResponse.json({ error: "NO_TENANT" }, { status: 403 });
  }

  // "Sign out everywhere" is `users.token_version`. Native sessions must obey
  // it, so we compare the live value against the version this session was
  // issued under. That baseline comes from the caller's own access token: it
  // is signed by us, so a thief cannot forge a newer `tv` to survive the
  // sweep, and a well-behaved client refreshes while it still holds a valid
  // one. (`auth_devices` keeps no per-device copy of token_version, so this is
  // the only tamper-proof baseline available to this route — a client that
  // only ever refreshes after its access token has expired is instead caught
  // by the claims re-minted below, which already reflect suspension,
  // subscription and permission changes.)
  const bearer = bearerFromHeader(h.get("authorization"));
  if (bearer) {
    const claims = await verifyAccessToken(bearer);
    // Ignore a token belonging to somebody else — some proxies attach the
    // browser session's header to every request.
    if (claims && claims.sub === row.user_id && claims.tv !== ctx.tokenVersion) {
      await db.execute(sql`
        UPDATE auth_devices
           SET revoked_at = now(), revoked_reason = 'token_version_bump'
         WHERE user_id = ${row.user_id}
           AND revoked_at IS NULL
      `);
      logger.info({
        event: "native_auth.refresh_token_version_stale",
        userId: row.user_id,
        tenantId: ctx.tenantId,
        deviceId: row.id,
      });
      return NextResponse.json({ error: "SESSION_REVOKED" }, { status: 401 });
    }
  }

  const { token: refreshToken, hash } = mintRefreshToken();

  const rotated = await db.transaction(async (tx) => {
    // `revoked_at IS NULL` in the WHERE is the concurrency guard: two parallel
    // refreshes with the same token race here, exactly one updates a row, and
    // the loser is told the token is invalid instead of both minting a
    // successor and leaving two live sessions behind.
    const burnt = (await tx.execute(sql`
      UPDATE auth_devices
         SET revoked_at = now(), revoked_reason = 'rotated'
       WHERE id = ${row.id} AND revoked_at IS NULL
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (burnt.length === 0) return null;

    // created_at is carried forward rather than defaulted: the devices screen
    // shows it as "signed in since", and a value that reset every 15 minutes
    // would make every session look brand new.
    const inserted = (await tx.execute(sql`
      INSERT INTO auth_devices
        (user_id, tenant_id, refresh_token_hash, device_name, platform,
         app_version, install_id, created_at, last_used_at, expires_at)
      VALUES
        (${row.user_id}, ${ctx.tenantId}, ${hash}, ${row.device_name},
         ${row.platform}, ${row.app_version}, ${row.install_id},
         ${row.created_at}, now(),
         now() + ${`${REFRESH_TTL_SEC} seconds`}::interval)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const nextId = inserted[0]?.id;
    if (!nextId) throw new Error("refresh rotation failed to insert successor");

    // The lineage pointer that makes reuse detectable. Written in the same
    // transaction as the revoke, so a row is never revoked-without-successor
    // while its successor is live.
    await tx.execute(sql`
      UPDATE auth_devices SET replaced_by_id = ${nextId} WHERE id = ${row.id}
    `);
    return nextId;
  });

  if (!rotated) {
    return NextResponse.json(
      { error: "INVALID_REFRESH_TOKEN" },
      { status: 401 },
    );
  }

  const accessToken = await signAccessToken({
    sub: row.user_id,
    tenantId: ctx.tenantId,
    role: ctx.role,
    permissions: ctx.permissions,
    tv: ctx.tokenVersion,
    did: rotated,
    susp: ctx.tenantSuspendedAt ? ctx.tenantSuspendedAt.toISOString() : null,
    mcp: ctx.mustChangePassword,
    sub_ok: ctx.subscriptionAccessActive,
  });

  // Suspension / password-rotation / subscription state is carried in the
  // claims, not enforced here: requireTenant() turns them into the same
  // TENANT_SUSPENDED / PASSWORD_CHANGE_REQUIRED / SUBSCRIPTION_REQUIRED bodies
  // the web gets. Refusing to refresh instead would strand the client with an
  // expired token and no way to learn why.
  return NextResponse.json({
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_SEC,
    deviceId: rotated,
  });
}
