import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeIdentifier, resolveTenantContext } from "@/lib/auth";
import { rateLimit, rateLimitConsume } from "@/lib/ratelimit";
import { issueTwoFactorChallenge } from "@/lib/api/native-login";
import { mintNativeSession } from "@/lib/api/native-session";
import { clientIp } from "@/lib/request-ip";

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

// Login rate-limit shape (doc 14 §10 M4 + D11). Same window as the web
// authorize(); the IP bucket is wider than the web's 10 because one shop NAT
// fronts every till and phone.
const LOGIN_IP_LIMIT = 30;
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_WINDOW_SEC = 15 * 60;

export async function POST(req: Request) {
  const h = await headers();
  const ip = clientIp(h);

  // Same buckets as the web login (lib/auth.ts authorize) so a native client
  // cannot be used to sidestep them — and the same discipline: PEEK here,
  // consume only after a failed password (M4). Counting successful logins
  // let five honest sign-ins in 15 minutes lock the account, and let anyone
  // who knew an email lock its owner out by logging in correctly on their
  // behalf. D11: the per-IP bucket is 30/15 min — a shop's shared NAT is one
  // address for every till and phone behind it.
  const byIp = await rateLimit("login.ip", ip, {
    limit: LOGIN_IP_LIMIT,
    windowSec: LOGIN_WINDOW_SEC,
    commit: false,
  });
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
    limit: LOGIN_EMAIL_LIMIT,
    windowSec: LOGIN_WINDOW_SEC,
    commit: false,
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
    // Only a FAILED password spends the buckets (M4) — mirrors lib/auth.ts.
    await Promise.all([
      rateLimitConsume("login.ip", ip, { limit: LOGIN_IP_LIMIT, windowSec: LOGIN_WINDOW_SEC }),
      rateLimitConsume("login.email", identifier, {
        limit: LOGIN_EMAIL_LIMIT,
        windowSec: LOGIN_WINDOW_SEC,
      }),
    ]);
    return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
  }

  // 2FA is enforced by the web flow inside authorize(). Rather than silently
  // skipping it for native — which would make the phone a way around it — the
  // password alone buys a short-lived one-shot CHALLENGE, which the app trades
  // for a session at /api/v1/auth/2fa/verify together with the code
  // (lib/api/native-login.ts). No session, no device row, no cookie yet.
  if (user.totpEnabledAt) {
    // Same refusal mintNativeSession would give after the code — better
    // before the user reaches for the authenticator than after.
    const ctx = await resolveTenantContext(user.id);
    if (!ctx.tenantId) {
      return NextResponse.json({ error: "NO_TENANT" }, { status: 403 });
    }
    const challengeToken = await issueTwoFactorChallenge(user.id, ctx.tenantId);
    return NextResponse.json(
      {
        error: "TOTP_REQUIRED",
        challengeToken,
        detail:
          "Second factor required: POST /api/v1/auth/2fa/verify with this challengeToken and the authenticator or recovery code",
      },
      { status: 409 },
    );
  }

  const session = await mintNativeSession(
    { id: user.id, email: user.email, name: user.name },
    {
      deviceName: body.deviceName,
      platform: body.platform,
      appVersion: body.appVersion,
      installId: body.installId,
    },
  );
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: 403 });
  }
  return NextResponse.json(session.body);
}
