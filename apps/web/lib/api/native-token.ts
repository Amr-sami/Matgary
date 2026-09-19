import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import type { Permission } from "@/lib/permissions";

// Native-client auth plane.
//
// The web app keeps its Auth.js cookie session untouched. This module adds a
// second, parallel transport for clients that have no cookie jar and no CSRF
// story — i.e. React Native.
//
// Shapes, and why:
//
//   ACCESS token   JWT, 15 minutes, stateless.
//     Carries the SAME claim set the web session already carries, so
//     `requireTenant()` can build an identical AuthedContext from either
//     transport and no route handler needs to know which one was used.
//
//   REFRESH token  opaque 32 random bytes, 90 days, one row per device.
//     Opaque because it must be revocable INDIVIDUALLY. The existing
//     `users.token_version` mechanism is per-USER: bumping it signs out every
//     device including the web. "Log out this phone" is impossible with it,
//     which is exactly what a lost handset needs. Only the SHA-256 of the
//     token is stored, so a database leak does not yield usable credentials.
//
// REVOCATION, and where it bites (migration 0052):
//
//   Access tokens are verified statelessly — `verifyAccessToken` is a
//   signature check and nothing else, no database on the hot path. That is
//   deliberate (one JWT verify per request, on every route) and it means a
//   revocation of any kind is enforced at the REFRESH, not on the next
//   request. A revoked device therefore keeps working for at most
//   ACCESS_TTL_SEC (15 minutes): the remaining life of the access token it
//   already holds. Both revocation paths land at the same place:
//
//     "sign out this device"  DELETE /api/v1/auth/devices?id=  tombstones the
//                             auth_devices row → its next refresh is refused.
//     "sign out everywhere"   bumps users.token_version AND tombstones every
//                             live row (lib/repo/account-security.ts). Each
//                             row also carries the users.token_version it was
//                             issued under (`auth_devices.token_version`), so
//                             a refresh whose row is behind the live value is
//                             refused even when the row was not swept — the
//                             2FA and password-reset bumps go that way — and
//                             even when the client sends no bearer at all.
//
//   `judgeRefresh` below is that decision, kept pure so it is unit-testable.

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 90 * 24 * 60 * 60;

/** Distinguishes these tokens from Auth.js's own JWE session cookie. */
const ISSUER = "matgary";
const AUDIENCE = "matgary-native";

export interface AccessClaims {
  sub: string;
  tenantId: string;
  role: string | null;
  permissions: Permission[];
  /** Mirrors users.token_version. Checked on refresh, not on every request. */
  tv: number;
  /** The auth_devices row this token was minted for, so a leak is
   *  attributable and the devices list can mark "this device". Not checked
   *  per request — see the REVOCATION note above. */
  did: string;
  /** Tenant suspended at this instant, or null. Mirrors the web JWT claim. */
  susp: string | null;
  /** Owner-forced password rotation outstanding. */
  mcp: boolean;
  /** Subscription grants access right now. */
  sub_ok: boolean;
  /** Issued-at, unix seconds, as read back by `verifyAccessToken` (0 when the
   *  token carries none). Set by `signAccessToken` itself — callers never
   *  supply it. The revocation check (lib/api/auth-helpers.ts, H4) uses it
   *  to let a token minted AFTER a "sign out everywhere" through. */
  iat?: number;
}

function secret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) {
    // Same failure mode as Auth.js itself — better a hard throw at first use
    // than tokens signed with an empty key.
    throw new Error("AUTH_SECRET is not set — cannot sign native access tokens");
  }
  // HS256 wants raw key bytes; AUTH_SECRET is an arbitrary-length string.
  return createHash("sha256").update(raw).digest();
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    tenantId: claims.tenantId,
    role: claims.role,
    permissions: claims.permissions,
    tv: claims.tv,
    did: claims.did,
    susp: claims.susp,
    mcp: claims.mcp,
    sub_ok: claims.sub_ok,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(secret());
}

/**
 * Verify an access token. Returns null for ANY failure — bad signature, wrong
 * issuer/audience, expired, malformed. Callers treat null as "no session" and
 * fall through to the cookie path, so a malformed Authorization header can
 * never escalate into an error page.
 */
export async function verifyAccessToken(
  token: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const p = payload as JWTPayload & Omit<AccessClaims, "sub">;
    if (!payload.sub || !p.tenantId) return null;
    return {
      sub: payload.sub,
      tenantId: p.tenantId,
      role: p.role ?? null,
      permissions: Array.isArray(p.permissions) ? p.permissions : [],
      tv: typeof p.tv === "number" ? p.tv : 0,
      did: typeof p.did === "string" ? p.did : "",
      susp: typeof p.susp === "string" ? p.susp : null,
      mcp: p.mcp === true,
      // Absent claim means "not granted". Failing closed matters here: a token
      // minted before this field existed must not imply a paid subscription.
      sub_ok: p.sub_ok === true,
      iat: typeof payload.iat === "number" ? payload.iat : 0,
    };
  } catch {
    return null;
  }
}

/** A refresh token and the hash to persist. The plaintext is returned once. */
export function mintRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare so a stored hash cannot be probed byte by byte. */
export function refreshTokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashRefreshToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Pull a bearer token out of an Authorization header.
 * Returns null unless the header is exactly `Bearer <token>`.
 */
export function bearerFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh verdict
// ─────────────────────────────────────────────────────────────────────────────

/** The auth_devices facts a refresh decision needs. Column names as SELECTed
 *  by /api/v1/auth/refresh, camel-cased. */
export interface RefreshRowFacts {
  /** revoked_at IS NOT NULL */
  revoked: boolean;
  /** replaced_by_id — set only by a successful rotation. */
  replacedById: string | null;
  /** expires_at <= now() */
  expired: boolean;
  /** auth_devices.token_version — users.token_version at issue time. */
  tokenVersion: number;
}

export type RefreshVerdict =
  /** Rotate and mint. */
  | { kind: "ok" }
  /** Revoked AND superseded: this token was already rotated, yet someone
   *  still presents it. Two parties hold the secret. Kill the whole chain. */
  | { kind: "reuse" }
  /** Ordinary dead token — logout, a device the user revoked, a reinstall. */
  | { kind: "revoked" }
  /** Past expires_at. Tombstone so the devices list stops showing it. */
  | { kind: "expired" }
  /** users.token_version moved since this session was issued: the user
   *  signed out everywhere (or rotated a credential that implies it). Every
   *  live session of theirs must go, this one included. */
  | { kind: "stale_version" };

/**
 * Decide what a presented refresh token gets, from the row it hashed to and
 * the user's LIVE token_version. Pure: the route does the SQL around it.
 *
 * Order matters. Reuse is checked before the plain revoked case because a
 * reused token IS revoked — the successor pointer is what distinguishes the
 * leak from an honest dead token. The version check comes last so that a
 * swept row (revoked by the sweep) reports `revoked`, not `stale_version`;
 * only a row the sweep never reached — a 2FA toggle, a password reset, or a
 * bump that raced the tombstone — reaches the version comparison. The
 * bearer is deliberately NOT an input: the baseline lives on the row.
 */
export function judgeRefresh(
  row: RefreshRowFacts,
  liveTokenVersion: number,
): RefreshVerdict {
  if (row.revoked && row.replacedById) return { kind: "reuse" };
  if (row.revoked) return { kind: "revoked" };
  if (row.expired) return { kind: "expired" };
  if (row.tokenVersion !== liveTokenVersion) return { kind: "stale_version" };
  return { kind: "ok" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2FA challenge token (doc 14 C7 / decision D3-b)
// ─────────────────────────────────────────────────────────────────────────────
//
// A native login whose password checked out but whose account has TOTP on
// gets a CHALLENGE instead of a session: a short-lived JWT that proves "this
// caller knew the password a moment ago" and nothing more. It is exchanged
// for a real session by /api/v1/auth/2fa/verify together with the code.
//
// Shape decisions:
//   - Its OWN audience. `verifyAccessToken` pins AUDIENCE, so a challenge can
//     never be presented as a bearer, and an access token can never be
//     replayed as a challenge. The `purpose` claim is belt to that brace.
//   - A jti, so Redis can hold "still redeemable + attempts so far" and the
//     token is one-shot (lib/api/native-login.ts). The JWT alone is stateless
//     and would otherwise be replayable for its whole life.
//   - Five minutes: long enough to open an authenticator app, short enough
//     that a token lifted from a log is worthless by the time it is read.

export const CHALLENGE_TTL_SEC = 5 * 60;
const CHALLENGE_AUDIENCE = "matgary-native-2fa";
const CHALLENGE_PURPOSE = "2fa";

export interface ChallengeClaims {
  sub: string;
  tenantId: string;
  jti: string;
  /** Unix seconds. Lets the redeem step size its Redis TTL to the token's. */
  exp: number;
}

export function mintChallengeId(): string {
  return randomBytes(16).toString("base64url");
}

export async function signChallengeToken(
  claims: Pick<ChallengeClaims, "sub" | "tenantId" | "jti">,
): Promise<string> {
  return new SignJWT({ tenantId: claims.tenantId, purpose: CHALLENGE_PURPOSE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuer(ISSUER)
    .setAudience(CHALLENGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SEC}s`)
    .sign(secret());
}

/**
 * Verify a challenge token. Null for ANY failure — bad signature, wrong
 * audience (an access token), wrong purpose, expired, malformed. The caller
 * answers every null with the same CHALLENGE_EXPIRED so the response cannot
 * be used to tell a forged token from a stale one.
 */
export async function verifyChallengeToken(
  token: string,
): Promise<ChallengeClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: CHALLENGE_AUDIENCE,
    });
    const p = payload as JWTPayload & { tenantId?: unknown; purpose?: unknown };
    if (
      !payload.sub ||
      !payload.jti ||
      typeof payload.exp !== "number" ||
      p.purpose !== CHALLENGE_PURPOSE ||
      typeof p.tenantId !== "string"
    ) {
      return null;
    }
    return { sub: payload.sub, tenantId: p.tenantId, jti: payload.jti, exp: payload.exp };
  } catch {
    return null;
  }
}
