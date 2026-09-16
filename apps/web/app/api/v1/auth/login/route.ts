import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeIdentifier, resolveTenantContext } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import {
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  mintRefreshToken,
  signAccessToken,
} from "@/lib/api/native-token";

// Native sign-in. One POST, one JSON response — no CSRF pre-flight, no
// redirect, no cookie.
//
// The web app's Auth.js credentials flow is untouched and still the only thing
// the browser uses. This route exists because that flow is a four-request
// browser handshake (GET /csrf -> POST /callback -> 302 -> cookie), which a
// React Native client cannot perform sensibly.
//
// Credential handling is NOT reimplemented here: identifier normalisation and
// tenant-context resolution are imported from lib/auth.ts, so a change to
// either applies to both transports.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // Either a real email or a synthetic staff identifier ("cashier@amr-store").
  // Deliberately NOT z.string().email() — staff identities have no TLD.
  identifier: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
  // Device metadata. Display-only; never trusted for authorisation.
  deviceName: z.string().max(120).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().max(40).optional(),
  /** Stable per install, so a reinstall replaces its old row. */
  installId: z.string().max(120).optional(),
});

function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() ?? "unknown";
}

export async function POST(req: Request) {
  const h = await headers();
  const ip = clientIp(h);

  // Same buckets as the web login so a native client cannot be used to
  // sidestep them.
  const byIp = await rateLimit("login.ip", ip, { limit: 10, windowSec: 900 });
  if (!byIp.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const identifier = normalizeIdentifier(body.identifier);
  const byIdentifier = await rateLimit("login.email", identifier, {
    limit: 5,
    windowSec: 900,
  });
  if (!byIdentifier.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(users)
    .where(eq(users.email, identifier))
    .limit(1);

  // One generic failure for "no such user" and "wrong password" alike, and a
  // bcrypt comparison against a dummy hash when the user is absent so the two
  // paths take comparable time.
  const DUMMY = "$2a$12$abcdefghijklmnopqrstuvwxyz012345678901234567890123456";
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY);
  if (!user || !ok) {
    return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
  }

  // 2FA is enforced by the web flow inside authorize(). Rather than silently
  // skipping it for native — which would make the phone a way around it — this
  // route refuses and defers to a dedicated challenge endpoint.
  if (user.totpEnabledAt) {
    return NextResponse.json(
      { error: "TOTP_REQUIRED", detail: "Use /api/v1/auth/2fa/verify" },
      { status: 409 },
    );
  }

  const ctx = await resolveTenantContext(user.id);
  if (!ctx.tenantId) {
    return NextResponse.json({ error: "NO_TENANT" }, { status: 403 });
  }

  // Retire any previous live row for this install before minting a new one,
  // so a reinstall does not leave a session the user cannot see or revoke.
  if (body.installId) {
    await db.execute(sql`
      UPDATE auth_devices
         SET revoked_at = now(), revoked_reason = 'reinstall'
       WHERE user_id = ${user.id}
         AND install_id = ${body.installId}
         AND revoked_at IS NULL
    `);
  }

  const { token: refreshToken, hash } = mintRefreshToken();
  const [device] = (await db.execute(sql`
    INSERT INTO auth_devices
      (user_id, tenant_id, refresh_token_hash, device_name, platform,
       app_version, install_id, expires_at)
    VALUES
      (${user.id}, ${ctx.tenantId}, ${hash}, ${body.deviceName ?? null},
       ${body.platform ?? null}, ${body.appVersion ?? null},
       ${body.installId ?? null},
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

  return NextResponse.json({
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
  });
}
