import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { resolveTenantContext } from "@/lib/auth";
import {
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  mintRefreshToken,
  signAccessToken,
} from "@/lib/api/native-token";

/**
 * Mint a native session for a user whose identity has ALREADY been
 * established by the caller.
 *
 * Lifted out of /api/v1/auth/login so that every route that ends in "and now
 * this user is signed in on this device" — password login, the demo tenant,
 * signup — produces byte-identical tokens and the same auth_devices row. The
 * alternative was three copies of the INSERT and three places for a claim to
 * drift.
 *
 * This function does NOT verify anything. Verifying the password, creating the
 * account, or cloning the demo tenant is the caller's job; this is only the
 * "issue tokens" step that follows.
 */
export interface DeviceMeta {
  deviceName?: string;
  platform?: "ios" | "android" | "web";
  appVersion?: string;
  installId?: string;
}

export type NativeSession =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "NO_TENANT" };

export async function mintNativeSession(
  user: { id: string; email: string; name: string | null },
  meta: DeviceMeta,
): Promise<NativeSession> {
  const ctx = await resolveTenantContext(user.id);
  if (!ctx.tenantId) return { ok: false, error: "NO_TENANT" };

  // Retire any previous live row for this install before minting a new one,
  // so a reinstall does not leave a session the user cannot see or revoke.
  if (meta.installId) {
    await db.execute(sql`
      UPDATE auth_devices
         SET revoked_at = now(), revoked_reason = 'reinstall'
       WHERE user_id = ${user.id}
         AND install_id = ${meta.installId}
         AND revoked_at IS NULL
    `);
  }

  const { token: refreshToken, hash } = mintRefreshToken();
  const [device] = (await db.execute(sql`
    INSERT INTO auth_devices
      (user_id, tenant_id, refresh_token_hash, device_name, platform,
       app_version, install_id, expires_at)
    VALUES
      (${user.id}, ${ctx.tenantId}, ${hash}, ${meta.deviceName ?? null},
       ${meta.platform ?? null}, ${meta.appVersion ?? null},
       ${meta.installId ?? null},
       now() + ${`${REFRESH_TTL_SEC} seconds`}::interval)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const accessToken = await signAccessToken({
    sub: user.id,
    tenantId: ctx.tenantId,
    role: ctx.role,
    permissions: ctx.permissions,
    tv: ctx.tokenVersion,
    did: device?.id ?? "",
    susp: ctx.tenantSuspendedAt ? ctx.tenantSuspendedAt.toISOString() : null,
    mcp: ctx.mustChangePassword,
    sub_ok: ctx.subscriptionAccessActive,
  });

  return {
    ok: true,
    body: {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_SEC,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: ctx.role,
        permissions: ctx.permissions,
        locale: ctx.locale,
      },
      tenant: {
        id: ctx.tenantId,
        slug: ctx.tenantSlug,
        suspended: Boolean(ctx.tenantSuspendedAt),
        subscriptionStatus: ctx.subscriptionStatus,
        subscriptionAccessActive: ctx.subscriptionAccessActive,
      },
      deviceId: device?.id ?? null,
    },
  };
}
