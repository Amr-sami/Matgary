/**
 * Digital collections 05 §4.16 (step 6) — purpose keys in lib/crypto.ts.
 *
 * `deriveKey(purpose)` = HKDF-SHA256(SECRET_KEY, "matgary.crypto.v1", purpose,
 * 32): deterministic per purpose, different across purposes, never the base
 * key. `encryptSecret` / `decryptSecret` take an optional key and keep the
 * `v1:` format, so the WhatsApp secrets (base key) are untouched.
 * `hmacSha256Hex(purpose, value)` is stable and purpose-bound.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  hmacSha256Hex,
  isEncrypted,
} from "@/lib/crypto";

const SECRET = "crypto-derive-test-secret-key";
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env.SECRET_KEY;
  process.env.SECRET_KEY = SECRET;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env.SECRET_KEY;
  else process.env.SECRET_KEY = prevSecret;
});

const baseKey = () => createHash("sha256").update(SECRET, "utf8").digest();

describe("deriveKey", () => {
  it("is 32 bytes, deterministic per purpose, and equals the pinned HKDF formula", () => {
    const a = deriveKey("collections.raw");
    const b = deriveKey("collections.raw");
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    const expected = Buffer.from(hkdfSync("sha256", Buffer.from(SECRET, "utf8"), "matgary.crypto.v1", "collections.raw", 32));
    expect(a.equals(expected)).toBe(true);
  });

  it("differs across purposes and from the base key", () => {
    const raw = deriveKey("collections.raw");
    const phone = deriveKey("collections.phone");
    expect(raw.equals(phone)).toBe(false);
    expect(raw.equals(baseKey())).toBe(false);
    expect(phone.equals(baseKey())).toBe(false);
  });

  it("follows a SECRET_KEY change (the memo is keyed by the secret too)", () => {
    const before = deriveKey("collections.raw");
    process.env.SECRET_KEY = SECRET + "-rotated";
    try {
      expect(deriveKey("collections.raw").equals(before)).toBe(false);
    } finally {
      process.env.SECRET_KEY = SECRET;
    }
    expect(deriveKey("collections.raw").equals(before)).toBe(true);
  });

  it("throws when SECRET_KEY is unset", () => {
    delete process.env.SECRET_KEY;
    try {
      expect(() => deriveKey("collections.phone")).toThrow(/SECRET_KEY/);
    } finally {
      process.env.SECRET_KEY = SECRET;
    }
  });
});

describe("encryptSecret / decryptSecret with a purpose key", () => {
  it("round-trips with the derived key, in the unchanged v1: format", () => {
    const key = deriveKey("collections.raw");
    const text = "تم استلام مبلغ 150.00 جنيه من 01012345678";
    const stored = encryptSecret(text, key);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.split(":")).toHaveLength(4);
    expect(decryptSecret(stored, key)).toBe(text);
  });

  it("a value encrypted with a purpose key does not decrypt with the base key", () => {
    const stored = encryptSecret("secret body", deriveKey("collections.raw"));
    expect(() => decryptSecret(stored)).toThrow();
    expect(() => decryptSecret(stored, deriveKey("collections.phone"))).toThrow();
  });

  it("without a key the base-key format is unchanged (WhatsApp secrets still round-trip)", () => {
    const stored = encryptSecret("green-api-token-123");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptSecret(stored)).toBe("green-api-token-123");
    expect(decryptSecret(stored, baseKey())).toBe("green-api-token-123");
    expect(() => decryptSecret(stored, deriveKey("collections.raw"))).toThrow();
  });

  it("empty and legacy plaintext paths are unchanged", () => {
    expect(encryptSecret("")).toBe("");
    expect(encryptSecret("", deriveKey("collections.raw"))).toBe("");
    expect(decryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBe("");
    expect(decryptSecret("plain-legacy")).toBe("plain-legacy");
  });
});

describe("hmacSha256Hex", () => {
  it("is stable, lower-case hex, and equals HMAC-SHA256 under the purpose key", () => {
    const h1 = hmacSha256Hex("collections.phone", "01012345678");
    const h2 = hmacSha256Hex("collections.phone", "01012345678");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHmac("sha256", deriveKey("collections.phone")).update("01012345678", "utf8").digest("hex");
    expect(h1).toBe(expected);
  });

  it("is purpose-bound and value-bound", () => {
    const phone = hmacSha256Hex("collections.phone", "01012345678");
    expect(hmacSha256Hex("collections.raw", "01012345678")).not.toBe(phone);
    expect(hmacSha256Hex("collections.phone", "01012345679")).not.toBe(phone);
  });
});
