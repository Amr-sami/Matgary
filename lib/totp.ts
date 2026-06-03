import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// Pure TOTP (RFC 6238) + recovery-code helpers. No DB, no Next runtime tie-in.
// Implemented in-tree rather than via otplib because v13's plugin-wiring is
// noisier than the 60 LOC of standards-compliant code below; everything here
// uses Node's built-in `crypto`.
//
// authorize / account-security routes import these; tests cover them.

const SERVICE = "Matgary";
const PERIOD_SECONDS = 30;
const WINDOW_TOLERANCE = 1; // accept previous + current + next step
const DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits — RFC 6238 recommendation, sha1
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_BYTES = 5; // → 10 hex chars per code

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  // RFC 4226 — HMAC-SHA1 of an 8-byte big-endian counter, then dynamic
  // truncation to a `DIGITS`-digit code zero-padded on the left.
  const ctr = Buffer.alloc(8);
  // 32-bit-safe: write high 32 bits then low 32 bits.
  ctr.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  ctr.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", secret).update(ctr).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binCode % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

export function buildOtpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`${SERVICE}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: SERVICE,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function verifyTotp(
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const stripped = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(stripped)) return false;
  let secretBuf: Buffer;
  try {
    secretBuf = base32Decode(secret);
  } catch {
    return false;
  }
  const step = Math.floor(nowSec / PERIOD_SECONDS);
  for (let off = -WINDOW_TOLERANCE; off <= WINDOW_TOLERANCE; off++) {
    const ctr = step + off;
    if (ctr < 0) continue; // negative counters don't exist in real TOTP timing
    if (hotp(secretBuf, ctr) === stripped) return true;
  }
  return false;
}

export interface RecoveryCodePair {
  plaintext: string;
  hash: string;
}

/** Generate N fresh recovery codes; return both plaintext (for display once)
 *  and the bcrypt hash (for storage). The plaintext set is shown to the
 *  user one time and never again. */
export async function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): Promise<RecoveryCodePair[]> {
  const out: RecoveryCodePair[] = [];
  for (let i = 0; i < count; i++) {
    const hex = crypto.randomBytes(RECOVERY_CODE_BYTES).toString("hex");
    const plaintext = `${hex.slice(0, 5)}-${hex.slice(5)}`;
    const hash = await bcrypt.hash(plaintext, 10);
    out.push({ plaintext, hash });
  }
  return out;
}

/** Test a candidate recovery code against the stored hash list. On match
 *  returns the index of the consumed hash so the caller can splice it out.
 *  bcrypt.compare is constant-time per entry; outer loop is necessarily
 *  O(n) but n is 8. */
export async function findRecoveryCodeIndex(
  candidate: string,
  hashes: ReadonlyArray<string>,
): Promise<number> {
  const normalized = candidate.trim().toLowerCase().replace(/\s+/g, "");
  for (let i = 0; i < hashes.length; i++) {
    try {
      if (await bcrypt.compare(normalized, hashes[i]!)) return i;
    } catch {
      // Malformed stored hash — skip.
    }
  }
  return -1;
}
