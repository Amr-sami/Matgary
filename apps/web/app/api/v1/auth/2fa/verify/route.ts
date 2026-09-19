import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";

import { rateLimit } from "@/lib/ratelimit";
import { redeemTwoFactorChallenge } from "@/lib/api/native-login";
import { mintNativeSession } from "@/lib/api/native-session";
import { clientIp } from "@/lib/request-ip";

// Second step of a native sign-in for an account with 2FA on.
//
// POST /api/v1/auth/login answered 409 TOTP_REQUIRED with a `challengeToken`;
// this route takes that token plus the 6-digit authenticator code (or one of
// the recovery codes) and answers with the SAME body a successful login
// answers with — tokens, user, tenant, deviceId — minted by the same
// mintNativeSession(). Nothing about the session differs from a login that
// had no second factor.
//
// Failure vocabulary (the app switches on `error`, not on the status):
//   400 INVALID_BODY
//   401 INVALID_CODE       { attemptsLeft }  — wrong code; 0 means the
//                                              challenge is now dead
//   401 CHALLENGE_EXPIRED                    — expired, consumed, forged,
//                                              out of attempts, 2FA off
//   403 NO_TENANT                            — same as login
//   429 RATE_LIMITED                         — per IP
//
// Guessing is bounded twice: CHALLENGE_MAX_ATTEMPTS per challenge (the
// challenge itself dies), and the per-IP bucket below so a fresh challenge per
// try does not reset the count. The per-challenge counter is the one that
// matters — the IP bucket mirrors login's so this route is not a cheaper
// target than the password step.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  challengeToken: z.string().min(16).max(4096),
  /** "123456" or a recovery code ("ab12c-3d4e5"); whitespace tolerated. */
  code: z.string().trim().min(6).max(24),
  /** Display-only, same fields as login. Never trusted for authorisation. */
  device: z
    .object({
      name: z.string().max(120).optional(),
      platform: z.enum(["ios", "android", "web"]).optional(),
      appVersion: z.string().max(40).optional(),
      /** Stable per install, so a reinstall replaces its old row. */
      installId: z.string().max(120).optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const h = await headers();
  const ip = clientIp(h);

  const byIp = await rateLimit("2fa.ip", ip, { limit: 10, windowSec: 900 });
  if (!byIp.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const verdict = await redeemTwoFactorChallenge(body.challengeToken, body.code);
  if (!verdict.ok) {
    return NextResponse.json(
      verdict.error === "INVALID_CODE"
        ? { error: verdict.error, attemptsLeft: verdict.attemptsLeft }
        : { error: verdict.error },
      { status: 401 },
    );
  }

  const session = await mintNativeSession(verdict.user, {
    deviceName: body.device?.name,
    platform: body.device?.platform,
    appVersion: body.device?.appVersion,
    installId: body.device?.installId,
  });
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: 403 });
  }
  return NextResponse.json(session.body);
}
