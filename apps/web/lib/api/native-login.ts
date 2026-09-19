import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { cacheDel, cacheGet, cacheSet, globalKey } from "@/lib/cache";
import { isCacheEnabled } from "@/lib/redis";
import { findRecoveryCodeIndex, verifyTotp } from "@/lib/totp";
import {
  CHALLENGE_TTL_SEC,
  mintChallengeId,
  signChallengeToken,
  verifyChallengeToken,
} from "@/lib/api/native-token";

// The second-factor step of a native login (doc 14 C7 / decision D3-b).
//
// /api/v1/auth/login stops at the password for an account with TOTP on and
// hands out a CHALLENGE (lib/api/native-token.ts); /api/v1/auth/2fa/verify
// trades that challenge plus a code for the ordinary session that
// mintNativeSession() issues. Both halves live here so the two routes stay
// one screen each and the one-shot / attempt-count rules have one home.
//
// State per challenge lives in Redis under the token's jti:
//
//   { userId, attempts }   written at issue with the token's own TTL
//                          deleted on success, on the 5th wrong code, and
//                          when 2FA turns out to be off by redeem time.
//
// That record is what makes the token ONE-SHOT and caps guessing at
// CHALLENGE_MAX_ATTEMPTS per challenge (~15 usable codes out of a million
// with the ±1 step window). The signed JWT alone would be replayable for its
// whole life.
//
// Redis absent (not configured, or the record could not be written): the
// challenge degrades to signature + 5-minute expiry, replayable within that
// window, guessing capped only by the per-IP limiter on the route — which is
// itself fail-open in the same outage. That is the codebase's standing
// trade (lib/ratelimit.ts, lib/cache.ts): a Redis outage must not lock every
// 2FA user out of the app, and the password-login brute-force guard is in
// exactly the same state when it happens. A stolen challenge still needs the
// authenticator.

export const CHALLENGE_MAX_ATTEMPTS = 5;

interface ChallengeRecord {
  userId: string;
  attempts: number;
}

function challengeKey(jti: string): string {
  return globalKey("auth", "2fa", jti);
}

/**
 * Issue a challenge for a user whose PASSWORD the caller has just verified.
 * The caller resolves the tenant first (a user with no tenant is refused
 * before a challenge exists — same answer login gives after 2FA).
 */
export async function issueTwoFactorChallenge(
  userId: string,
  tenantId: string,
): Promise<string> {
  const jti = mintChallengeId();
  const record: ChallengeRecord = { userId, attempts: 0 };
  await cacheSet(challengeKey(jti), record, CHALLENGE_TTL_SEC);
  return signChallengeToken({ sub: userId, tenantId, jti });
}

export type ChallengeVerdict =
  /** Second factor passed; the challenge is consumed. Mint the session. */
  | { ok: true; user: { id: string; email: string; name: string | null } }
  /** Bad signature, expired, already redeemed, out of attempts, 2FA now
   *  off — every "start over at the password" case, indistinguishably. */
  | { ok: false; error: "CHALLENGE_EXPIRED" }
  /** Wrong code. attemptsLeft 0 means this was the last one: the challenge
   *  is gone and the next call is CHALLENGE_EXPIRED. */
  | { ok: false; error: "INVALID_CODE"; attemptsLeft: number };

const EXPIRED: ChallengeVerdict = { ok: false, error: "CHALLENGE_EXPIRED" };

/**
 * Redeem a challenge with a TOTP code or a recovery code.
 *
 * Recovery codes are checked the way the credentials authorize() step does
 * (lib/repo/account-security.ts verifySecondFactor): bcrypt against the
 * stored list, and the matching hash is removed so the code is single-use.
 */
export async function redeemTwoFactorChallenge(
  challengeToken: string,
  code: string,
): Promise<ChallengeVerdict> {
  const claims = await verifyChallengeToken(challengeToken);
  if (!claims) return EXPIRED;

  const key = challengeKey(claims.jti);
  const record = await cacheGet<ChallengeRecord>(key);
  if (record) {
    // A record under this jti for another user cannot happen without a key
    // collision; refuse rather than reason about it.
    if (record.userId !== claims.sub || record.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      await cacheDel(key);
      return EXPIRED;
    }
  } else if (isCacheEnabled()) {
    // Consumed, dead, or past its TTL. (Without Redis there is no record to
    // miss — see the module note.)
    return EXPIRED;
  }

  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      totpSecret: users.totpSecret,
      totpEnabledAt: users.totpEnabledAt,
      recoveryCodesHash: users.recoveryCodesHash,
    })
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  // 2FA switched off (or the account went away) between the password and the
  // code: the challenge has nothing left to prove. A fresh login now succeeds
  // without one.
  if (!u || !u.totpEnabledAt || !u.totpSecret) {
    await cacheDel(key);
    return EXPIRED;
  }

  let passed = verifyTotp(code, u.totpSecret);
  if (!passed) {
    const hashes = (u.recoveryCodesHash ?? []) as string[];
    const idx = await findRecoveryCodeIndex(code, hashes);
    if (idx >= 0) {
      await db
        .update(users)
        .set({ recoveryCodesHash: hashes.filter((_, i) => i !== idx) })
        .where(eq(users.id, u.id));
      passed = true;
    }
  }

  if (!passed) {
    const attempts = (record?.attempts ?? 0) + 1;
    const attemptsLeft = Math.max(0, CHALLENGE_MAX_ATTEMPTS - attempts);
    if (attemptsLeft === 0) {
      await cacheDel(key);
    } else {
      // Keep the record's life pinned to the token's, not restarted per try.
      // `exp` is whole seconds; rounding now UP keeps the record from ever
      // outliving the token by the fractional part.
      const ttl = claims.exp - Math.ceil(Date.now() / 1000);
      await cacheSet(key, { userId: u.id, attempts }, Math.max(1, ttl));
    }
    return { ok: false, error: "INVALID_CODE", attemptsLeft };
  }

  // One-shot: gone before the tokens exist, so a concurrent replay of the
  // same challenge finds nothing.
  await cacheDel(key);
  return { ok: true, user: { id: u.id, email: u.email, name: u.name } };
}
