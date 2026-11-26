// Password rules + bcrypt helpers. See docs/specs/platform-admin-dashboard.md §2.4.
//
// The constants here are the single source of truth — every UI hint, every
// validator, every test reads from this file. Changing a rule means changing
// the test, the UI copy, and the validator simultaneously.

import bcrypt from "bcryptjs";
import { and, desc, eq } from "drizzle-orm";
import { adminPasswordHistory } from "@/lib/db/schema";
import { getAdminDb } from "./db";

export const PASSWORD_RULES = {
  minLength: 12,
  requireLower: true,
  requireUpper: true,
  requireDigit: true,
  bcryptCost: 12,
  historyDepth: 3,
  rotationDays: 90,
  rotationWarnDays: 7,
} as const;

export type PasswordValidationError =
  | "TOO_SHORT"
  | "NEED_LOWER"
  | "NEED_UPPER"
  | "NEED_DIGIT"
  | "PASSWORD_REUSED";

export function validatePasswordShape(pw: string): PasswordValidationError | null {
  if (pw.length < PASSWORD_RULES.minLength) return "TOO_SHORT";
  if (PASSWORD_RULES.requireLower && !/[a-z]/.test(pw)) return "NEED_LOWER";
  if (PASSWORD_RULES.requireUpper && !/[A-Z]/.test(pw)) return "NEED_UPPER";
  if (PASSWORD_RULES.requireDigit && !/[0-9]/.test(pw)) return "NEED_DIGIT";
  return null;
}

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, PASSWORD_RULES.bcryptCost);
}

export function comparePassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/** Check the proposed plaintext against the admin's last-N password hashes.
 *  Returns true when reuse is detected. */
export async function isPasswordReused(
  adminId: string,
  plaintext: string,
): Promise<boolean> {
  const db = getAdminDb();
  const recent = await db
    .select({ hash: adminPasswordHistory.passwordHash })
    .from(adminPasswordHistory)
    .where(eq(adminPasswordHistory.adminId, adminId))
    .orderBy(desc(adminPasswordHistory.changedAt))
    .limit(PASSWORD_RULES.historyDepth);
  for (const r of recent) {
    if (await bcrypt.compare(plaintext, r.hash)) return true;
  }
  return false;
}

/** Append the new hash to the admin's history. Called after a successful
 *  rotation. The repo doesn't prune older rows — admin_session_cleanup cron
 *  trims rows past the retention window. */
export async function appendPasswordHistory(
  adminId: string,
  hash: string,
): Promise<void> {
  const db = getAdminDb();
  await db.insert(adminPasswordHistory).values({ adminId, passwordHash: hash });
}
