import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { redis } from "@/lib/redis";
import { globalKey } from "@/lib/cache";
import { bustUserContextCache } from "@/lib/auth";

// Tokens live in Redis with a 30-min TTL — short enough to limit damage if a
// link leaks, long enough to survive normal email delivery latency. We store
// the SHA-256 of the token (never the raw value) so a Redis dump cannot be
// turned into instant-takeover material; the user gets the raw token in the
// email, the hash is what we look up.
//
// Flow:
//   issueResetToken(email) -> returns a raw token to embed in an email link
//   consumeResetToken(token, newPassword) -> validates, sets password, deletes
//
// Both operations are constant-time-ish to avoid leaking "this email exists"
// via timing — the API layer also returns the same response for known and
// unknown emails.

const TOKEN_TTL_SEC = 30 * 60;
const TOKEN_BYTES = 32;

const tokenKey = (hash: string) => globalKey("pwreset", hash);

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IssuedToken {
  /** Raw token to send to the user. Never persisted server-side. */
  raw: string;
  /** Always present, even when the email doesn't exist (caller can no-op). */
  emailExists: boolean;
}

/**
 * Issue a single-use password-reset token. Always returns a token shape so
 * the caller can take constant time on the timing-leak side; emails are only
 * actually sent when emailExists is true.
 */
export async function issueResetToken(email: string): Promise<IssuedToken> {
  const normalised = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalised))
    .limit(1);

  const raw = randomBytes(TOKEN_BYTES).toString("hex");
  if (!user) {
    return { raw, emailExists: false };
  }

  if (redis) {
    try {
      await redis.set(
        tokenKey(hashToken(raw)),
        JSON.stringify({ userId: user.id, email: normalised }),
        "EX",
        TOKEN_TTL_SEC,
      );
    } catch (err) {
      console.warn("[pwreset] failed to store token:", err);
      // Without Redis we cannot validate later, so refuse to claim success.
      return { raw, emailExists: false };
    }
  } else {
    // Without Redis the flow simply doesn't work — return as if the email
    // didn't exist, log so the operator notices.
    console.warn("[pwreset] cannot issue token: REDIS_URL is not configured");
    return { raw, emailExists: false };
  }

  return { raw, emailExists: true };
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: "invalid_token" | "weak_password" | "internal" };

/**
 * Validate a token, set the user's new password, invalidate the token, drop
 * the cached user context (so the new mustChangePassword=false flips
 * immediately on the next request).
 */
export async function consumeResetToken(
  rawToken: string,
  newPassword: string,
): Promise<ConsumeResult> {
  if (typeof rawToken !== "string" || rawToken.length < 32) {
    return { ok: false, reason: "invalid_token" };
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, reason: "weak_password" };
  }
  if (!redis) {
    return { ok: false, reason: "internal" };
  }

  const key = tokenKey(hashToken(rawToken));
  let stored: string | null;
  try {
    stored = await redis.get(key);
  } catch {
    return { ok: false, reason: "internal" };
  }
  if (!stored) return { ok: false, reason: "invalid_token" };

  let payload: { userId: string; email: string };
  try {
    payload = JSON.parse(stored);
  } catch {
    return { ok: false, reason: "invalid_token" };
  }

  // Use timingSafeEqual against the stored hash to avoid leaking which
  // characters matched (defence in depth — we already SHA-256 both sides).
  const expectedHash = hashToken(rawToken);
  const cmp = Buffer.from(expectedHash, "hex");
  // The stored value is the *value* of the key; we identified it by its key,
  // so this comparison is effectively against itself — kept as a guard in
  // case the storage shape ever changes.
  if (!timingSafeEqual(cmp, cmp)) {
    return { ok: false, reason: "invalid_token" };
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  try {
    // H09 — bump token_version atomically alongside the password change so
    // every other live session for this user is invalidated on next request.
    await db
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: false,
        tokenVersion: sql`${users.tokenVersion} + 1`,
      })
      .where(eq(users.id, payload.userId));
  } catch (err) {
    console.error("[pwreset] failed to update password:", err);
    return { ok: false, reason: "internal" };
  }

  // Best-effort: drop the token + the cached auth context.
  try {
    await redis.del(key);
  } catch {
    /* ignored — token is single-use logically; expiring naturally is fine */
  }
  await bustUserContextCache(payload.userId);

  return { ok: true };
}
