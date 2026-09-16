import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  buildOtpauthUri,
  findRecoveryCodeIndex,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotp,
} from "@/lib/totp";
import { bustUserContextCache } from "@/lib/auth";
import { rateLimit, rateLimitConsume } from "@/lib/ratelimit";

// F-03 — 2FA mutation paths (disable + regenerate) require a TOTP code on
// top of the user's password. Without throttling, a stolen session + known
// password could brute-force the 6-digit code (~1M combinations) at full
// CPU speed. The login flow's `auth.totp` bucket doesn't apply here, so
// we mirror the same pattern at this layer: 5 wrong attempts in 15 min
// locks the user out of these mutations. Successful calls don't consume
// the bucket so a legit user with typo'd codes doesn't lock themselves
// out fast. Bucket is per-user (not per-IP) so an attacker on a fresh
// IP can't reset the counter by switching networks.
const TOTP_MUT_LIMIT = 5;
const TOTP_MUT_WINDOW_SEC = 15 * 60;

export class TotpRateLimitedError extends Error {
  constructor() {
    super("RATE_LIMITED");
    this.name = "TotpRateLimitedError";
  }
}

async function peekTotpMutationBucket(userId: string): Promise<boolean> {
  const peek = await rateLimit("auth.totp.account_mut", userId, {
    limit: TOTP_MUT_LIMIT,
    windowSec: TOTP_MUT_WINDOW_SEC,
    commit: false,
  });
  return peek.ok;
}

async function consumeTotpMutationFailure(userId: string): Promise<void> {
  await rateLimitConsume("auth.totp.account_mut", userId, {
    limit: TOTP_MUT_LIMIT,
    windowSec: TOTP_MUT_WINDOW_SEC,
  });
}

// H03 — server-side helpers for the 2FA lifecycle. All mutations bust the
// user-context cache so a newly-enrolled / disabled state is reflected on
// the next request without waiting for the 60 s TTL.

export interface EnrollmentPreview {
  /** Base32 secret — committed to the user row only after verifyAndEnable. */
  secret: string;
  /** otpauth:// URI for QR rendering. */
  otpauthUri: string;
}

export async function startEnrollment(email: string): Promise<EnrollmentPreview> {
  const secret = generateTotpSecret();
  return { secret, otpauthUri: buildOtpauthUri(email, secret) };
}

export interface EnableResult {
  recoveryCodes: string[];
}

/** Commit a verified TOTP secret to the user, generate + store hashed
 *  recovery codes, and return the plaintext codes once for display. */
export async function verifyAndEnable(
  userId: string,
  secret: string,
  token: string,
): Promise<EnableResult> {
  if (!verifyTotp(token, secret)) {
    throw new Error("INVALID_TOTP");
  }
  const codes = await generateRecoveryCodes();
  await db
    .update(users)
    .set({
      totpSecret: secret,
      totpEnabledAt: new Date(),
      recoveryCodesHash: codes.map((c) => c.hash),
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, userId));
  await bustUserContextCache(userId);
  return { recoveryCodes: codes.map((c) => c.plaintext) };
}

export async function disable2fa(
  userId: string,
  password: string,
  token: string,
): Promise<void> {
  // F-03 — peek before the bcrypt + verifyTotp work so a locked-out user
  // doesn't even burn CPU on the password compare.
  if (!(await peekTotpMutationBucket(userId))) {
    throw new TotpRateLimitedError();
  }
  const [u] = await db
    .select({
      passwordHash: users.passwordHash,
      totpSecret: users.totpSecret,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.passwordHash || !u.totpSecret) throw new Error("NOT_ENROLLED");
  if (!(await bcrypt.compare(password, u.passwordHash))) {
    await consumeTotpMutationFailure(userId);
    throw new Error("BAD_PASSWORD");
  }
  if (!verifyTotp(token, u.totpSecret)) {
    await consumeTotpMutationFailure(userId);
    throw new Error("INVALID_TOTP");
  }
  await db
    .update(users)
    .set({
      totpSecret: null,
      totpEnabledAt: null,
      recoveryCodesHash: null,
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, userId));
  await bustUserContextCache(userId);
}

export async function regenerateRecoveryCodes(
  userId: string,
  password: string,
  token: string,
): Promise<string[]> {
  // F-03 — same rate-limit shape as disable2fa.
  if (!(await peekTotpMutationBucket(userId))) {
    throw new TotpRateLimitedError();
  }
  const [u] = await db
    .select({
      passwordHash: users.passwordHash,
      totpSecret: users.totpSecret,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.passwordHash || !u.totpSecret) throw new Error("NOT_ENROLLED");
  if (!(await bcrypt.compare(password, u.passwordHash))) {
    await consumeTotpMutationFailure(userId);
    throw new Error("BAD_PASSWORD");
  }
  if (!verifyTotp(token, u.totpSecret)) {
    await consumeTotpMutationFailure(userId);
    throw new Error("INVALID_TOTP");
  }
  const codes = await generateRecoveryCodes();
  await db
    .update(users)
    .set({ recoveryCodesHash: codes.map((c) => c.hash) })
    .where(eq(users.id, userId));
  return codes.map((c) => c.plaintext);
}

/** Used by the credentials authorize step: given a logged-in-in-progress
 *  user, verify the supplied 6-digit TOTP or one of the recovery codes.
 *  On recovery-code success the consumed hash is removed from the array. */
export async function verifySecondFactor(
  userId: string,
  candidate: string,
): Promise<boolean> {
  const [u] = await db
    .select({
      totpSecret: users.totpSecret,
      totpEnabledAt: users.totpEnabledAt,
      recoveryCodesHash: users.recoveryCodesHash,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.totpSecret || !u.totpEnabledAt) return true; // 2FA off — pass-through.
  const stripped = candidate.replace(/\s+/g, "");
  if (verifyTotp(stripped, u.totpSecret)) return true;
  const hashes = (u.recoveryCodesHash ?? []) as string[];
  const idx = await findRecoveryCodeIndex(candidate, hashes);
  if (idx >= 0) {
    const next = hashes.filter((_, i) => i !== idx);
    await db
      .update(users)
      .set({ recoveryCodesHash: next })
      .where(eq(users.id, userId));
    return true;
  }
  return false;
}

/** H09 — atomic increment of `users.token_version`. Invalidates every JWT
 *  issued for this user before the call. Callers should also bust the
 *  user-context cache so the bump is visible on the next request. */
export async function bumpTokenVersion(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));
  await bustUserContextCache(userId);
}

export async function isTotpEnabled(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ totpEnabledAt: users.totpEnabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!u?.totpEnabledAt;
}
