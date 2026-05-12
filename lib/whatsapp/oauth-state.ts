// HMAC-signed state token for the Embedded Signup OAuth round-trip.
//
// The payload encodes (tenantId, branchId, userId, nonce, iat). Both the
// `state=` query param and a parallel httpOnly cookie carry the same token;
// the callback rejects unless they match (defence against CSRF and against
// a stolen authorize-redirect link being completed by a different user).

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SIG_LEN_BYTES = 32; // HMAC-SHA256 -> 32 bytes
const STATE_MAX_AGE_SEC = 15 * 60; // 15 minutes is plenty for an OAuth round-trip

export interface OAuthStatePayload {
  tenantId: string;
  branchId: string;
  userId: string;
  // Random nonce so two consecutive Connect clicks produce distinct states.
  nonce: string;
  // Issued-at, unix seconds.
  iat: number;
}

function secret(): Buffer {
  // Re-use AUTH_SECRET — it's already required at app boot, so we don't
  // introduce a new mandatory env var. Different *purpose* than session
  // signing, but functionally equivalent (HMAC of opaque server payload).
  const s = process.env.AUTH_SECRET;
  if (!s) {
    throw new Error("AUTH_SECRET is not set — required for OAuth state signing");
  }
  return Buffer.from(s, "utf8");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signState(input: Omit<OAuthStatePayload, "nonce" | "iat">): string {
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomBytes(8).toString("hex"),
    iat: Math.floor(Date.now() / 1000),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(state: string | null | undefined): OAuthStatePayload | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  let sigBuf: Buffer;
  let expected: Buffer;
  try {
    sigBuf = b64urlDecode(sig);
    expected = createHmac("sha256", secret()).update(body).digest();
  } catch {
    return null;
  }
  if (sigBuf.length !== SIG_LEN_BYTES || expected.length !== SIG_LEN_BYTES) {
    return null;
  }
  if (!timingSafeEqual(sigBuf, expected)) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  // Sanity-check shape.
  if (
    typeof payload.tenantId !== "string" ||
    typeof payload.branchId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.iat !== "number"
  ) {
    return null;
  }
  // Reject stale states.
  const ageSec = Math.floor(Date.now() / 1000) - payload.iat;
  if (ageSec > STATE_MAX_AGE_SEC || ageSec < -60) return null;

  return payload;
}

// Cookie used to bind the state token to *this* browser session. If the
// `state` query param doesn't match the cookie, we treat it as a CSRF
// attempt regardless of HMAC validity.
export const OAUTH_STATE_COOKIE = "mg.wa_oauth_state";

export function oauthStateCookieAttributes(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    // Just long enough to outlive an OAuth round-trip. We delete it on
    // the callback regardless of outcome.
    maxAge: STATE_MAX_AGE_SEC + 60,
  };
}
