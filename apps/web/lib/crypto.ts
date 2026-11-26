import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// AES-256-GCM symmetric encryption for at-rest secrets (Green API token).
// Format on disk: "v1:<iv-base64>:<ciphertext-base64>:<tag-base64>"
// IV is 12 bytes (GCM standard), tag is 16 bytes.

const ALGO = "aes-256-gcm";
const PREFIX = "v1:";

function getKey(): Buffer {
  const raw = process.env.SECRET_KEY;
  if (!raw) throw new Error("SECRET_KEY is not set");
  // Allow either raw 32-byte string or any-length passphrase — derive a 32-byte key via SHA-256.
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * Purposes a key may be derived for (digital collections 03 §B.13, 05 §4.16):
 * `collections.raw` encrypts forwarded bank/wallet message text,
 * `collections.phone` keys the payer-phone HMAC. No new secret: every purpose
 * key is HKDF-SHA256 of the existing SECRET_KEY, so a leak of one purpose key
 * reveals neither the base key nor another purpose's.
 */
export type KeyPurpose = "collections.raw" | "collections.phone";

const HKDF_SALT = "matgary.crypto.v1";
const derivedKeys = new Map<string, Buffer>();

/** 32-byte purpose key = HKDF-SHA256(SECRET_KEY utf8, salt "matgary.crypto.v1",
 *  info = purpose). Memoised per (SECRET_KEY, purpose). */
export function deriveKey(purpose: KeyPurpose): Buffer {
  const raw = process.env.SECRET_KEY;
  if (!raw) throw new Error("SECRET_KEY is not set");
  const memo = `${purpose}\u0000${raw}`;
  const hit = derivedKeys.get(memo);
  if (hit) return hit;
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), HKDF_SALT, purpose, 32));
  derivedKeys.set(memo, key);
  return key;
}

/** HMAC-SHA256 of `value` under the purpose key, lower-case hex (exact
 *  equality only — e.g. `collection_credits.payer_phone_hmac`). */
export function hmacSha256Hex(purpose: KeyPurpose, value: string): string {
  return createHmac("sha256", deriveKey(purpose)).update(value, "utf8").digest("hex");
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** `key` defaults to the base SECRET_KEY key (WhatsApp credentials); pass
 *  `deriveKey(purpose)` for a purpose key. The stored format is the same. */
export function encryptSecret(plaintext: string, key?: Buffer): string {
  if (!plaintext) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key ?? getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${enc.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined, key?: Buffer): string {
  if (!stored) return "";
  if (!isEncrypted(stored)) return stored; // legacy plaintext — return as-is
  const [, ivB64, encB64, tagB64] = stored.split(":");
  if (!ivB64 || !encB64 || !tagB64) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv(ALGO, key ?? getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
