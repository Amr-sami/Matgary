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
    throw new Error("BAD_PASSWORD");
  }
  if (!verifyTotp(token, u.totpSecret)) throw new Error("INVALID_TOTP");
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
    throw new Error("BAD_PASSWORD");
  }
  if (!verifyTotp(token, u.totpSecret)) throw new Error("INVALID_TOTP");
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
