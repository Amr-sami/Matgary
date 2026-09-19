import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db, withTenant } from "@/lib/db";
import { pushTokens } from "@/lib/db/schema";
import { isExpoPushToken } from "@/lib/push/expo-push";
import { rateLimit } from "@/lib/ratelimit";
import { hashRefreshToken } from "@/lib/api/native-token";
import { markDevicesRevoked } from "@/lib/api/auth-helpers";
import { clientIp } from "@/lib/request-ip";

// Sign out ONE device.
//
// No session is required: possession of the refresh token is the authority to
// destroy it, and demanding a valid access token would make logout impossible
// in the case that needs it most — the access token has expired and the user
// wants out.
//
// Deliberately idempotent and deliberately blind. An unknown token, an
// already-revoked token and a successful revoke all return the same 200, so a
// client retrying over a flaky connection is never stuck in a "logout failed"
// loop, and nobody can use this endpoint as an oracle for which token hashes
// exist.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  refreshToken: z.string().min(20).max(500),
  // The device's Expo push token, when the app has one. Signing out must also
  // stop the pushes — a phone handed to someone else must not keep buzzing
  // with the previous user's tasks. Optional AND lenient: a simulator, a
  // device that denied notification permission, or a client that forwards
  // its stored value verbatim ("" / null) has nothing valid to send, and a
  // convenience field must never veto the revocation — anything that is not
  // an Expo token is simply ignored below.
  pushToken: z.unknown().optional(),
});

export async function POST(req: Request) {
  const h = await headers();

  // Loose enough that honest retries never trip it, tight enough that the
  // endpoint cannot be driven as a bulk revocation probe.
  const limited = await rateLimit("auth.logout.ip", clientIp(h), {
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
    // A malformed request is a client bug, not a missing token — say so. This
    // leaks nothing: it is decided before any lookup happens.
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const tokenHash = hashRefreshToken(body.refreshToken);

  // `revoked_at IS NULL` keeps a retry from overwriting the original reason
  // and timestamp of an earlier revoke (e.g. a 'token_reuse' sweep). RETURNING
  // the owner lets the push purge below stay scoped to that user without a
  // second lookup — and stays blind: an unknown token returns no row and the
  // response is the same 200 either way.
  const revoked = (await db.execute(sql`
    UPDATE auth_devices
       SET revoked_at = now(), revoked_reason = 'logout'
     WHERE refresh_token_hash = ${tokenHash}
       AND revoked_at IS NULL
    RETURNING id, user_id, tenant_id
  `)) as unknown as Array<{ id: string; user_id: string; tenant_id: string }>;

  // H4 — the access token this device still holds names this row (`did`);
  // mark it so the token dies now, not at its natural expiry. Best-effort.
  await markDevicesRevoked(revoked.map((r) => r.id));

  // Same-device retry after the refresh token was already revoked: the push
  // token must still be silenced, so fall back to the (now revoked) row's owner.
  const owner =
    revoked[0] ??
    ((await db.execute(sql`
      SELECT id, user_id, tenant_id FROM auth_devices
       WHERE refresh_token_hash = ${tokenHash}
       LIMIT 1
    `)) as unknown as Array<{ id: string; user_id: string; tenant_id: string }>)[0];

  const pushToken = isExpoPushToken(body.pushToken) ? body.pushToken : null;
  if (pushToken && owner) {
    // Only the token's owner can silence it: the refresh token proves who is
    // asking, and the UPDATE is pinned to that user. Under RLS via withTenant.
    await withTenant(owner.tenant_id, async (tx) => {
      await tx
        .update(pushTokens)
        .set({ disabledAt: new Date() })
        .where(
          and(
            eq(pushTokens.tenantId, owner.tenant_id),
            eq(pushTokens.userId, owner.user_id),
            eq(pushTokens.expoToken, pushToken),
            isNull(pushTokens.disabledAt),
          ),
        );
    });
  }

  return NextResponse.json({ ok: true });
}
