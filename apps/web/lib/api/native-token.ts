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
// `token_version` is still checked on every refresh, so the existing
// "sign out everywhere" flow keeps working for native sessions for free.

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
  /** The device this token was minted for, so a leak is attributable. */
  did: string;
  /** Tenant suspended at this instant, or null. Mirrors the web JWT claim. */
  susp: string | null;
  /** Owner-forced password rotation outstanding. */
  mcp: boolean;
  /** Subscription grants access right now. */
  sub_ok: boolean;
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
