import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

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

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${enc.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!isEncrypted(stored)) return stored; // legacy plaintext — return as-is
  const [, ivB64, encB64, tagB64] = stored.split(":");
  if (!ivB64 || !encB64 || !tagB64) {
    throw new Error("Malformed encrypted secret");
  }
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
