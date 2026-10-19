/**
 * Doc 15 spec 07 §7 — lib/collections/raw-text.ts (no DB).
 *
 * Forwarded-message text at rest: AES-256-GCM under the `collections.raw`
 * purpose key (never the base SECRET_KEY key), the [title, subtitle] JSON of
 * `title_enc`, the NFC body hash, the payer-phone HMAC over 06's national
 * form, and the §4.10 retention table (shared wins, then test, then status).
 * `maskPayerName` / `phoneLast4` are 06's and tested there.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret } from "@/lib/crypto";
import {
  bodySha256,
  decodeTitleSubtitle,
  decryptRawText,
  encodeTitleSubtitle,
  encryptRawText,
  payerPhoneHmac,
  rawExpiresAt,
} from "@/lib/collections/raw-text";

const saved = process.env.SECRET_KEY;
const DAY = 86_400_000;

beforeEach(() => {
  process.env.SECRET_KEY = "raw-text-test-secret-0123456789abcdef";
});
afterEach(() => {
  if (saved === undefined) delete process.env.SECRET_KEY;
  else process.env.SECRET_KEY = saved;
});

describe("encryptRawText / decryptRawText (§4.10)", () => {
  it("round-trips Arabic text in the v1:<iv>:<ct>:<tag> format with a fresh IV each time", () => {
    const body = "تم استلام مبلغ 2700.00 جنيه من رقم 01127777705";
    const a = encryptRawText(body);
    const b = encryptRawText(body);
    expect(a).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("2700");
    expect(decryptRawText(a)).toBe(body);
    expect(decryptRawText(b)).toBe(body);
  });

  it("does NOT decrypt with the base SECRET_KEY key (decryptSecret) — a different key", () => {
    const enc = encryptRawText("secret message");
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("does not decrypt under a different SECRET_KEY", () => {
    const enc = encryptRawText("secret message");
    process.env.SECRET_KEY = "another-secret-key-entirely-0000000000";
    expect(() => decryptRawText(enc)).toThrow();
  });

  it("null / empty stays null", () => {
    expect(decryptRawText(null)).toBeNull();
    expect(decryptRawText(undefined)).toBeNull();
    expect(decryptRawText("")).toBeNull();
  });
});

describe("title_enc = [title, subtitle] JSON", () => {
  it("encodes both, either, or neither (null)", () => {
    expect(encodeTitleSubtitle("InstaPay", "NBE")).toBe('["InstaPay","NBE"]');
    expect(encodeTitleSubtitle(null, "NBE")).toBe('[null,"NBE"]');
    expect(encodeTitleSubtitle("", "")).toBeNull();
    expect(encodeTitleSubtitle(undefined, null)).toBeNull();
  });

  it("decodes losslessly; a legacy plain string reads as the title", () => {
    expect(decodeTitleSubtitle('["T","S"]')).toEqual({ title: "T", subtitle: "S" });
    expect(decodeTitleSubtitle('[null,"S"]')).toEqual({ title: null, subtitle: "S" });
    expect(decodeTitleSubtitle("plain title")).toEqual({ title: "plain title", subtitle: null });
    expect(decodeTitleSubtitle(null)).toEqual({ title: null, subtitle: null });
  });
});

describe("bodySha256", () => {
  it("is the SHA-256 hex of the NFC-normalised body (NFD input hashes the same)", () => {
    const nfc = "café";
    const nfd = "café";
    expect(bodySha256(nfc)).toBe(createHash("sha256").update(nfc, "utf8").digest("hex"));
    expect(bodySha256(nfd)).toBe(bodySha256(nfc));
    expect(bodySha256("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("payerPhoneHmac", () => {
  it("is equal for +201001234567 / 01001234567 / 00201001234567", () => {
    const a = payerPhoneHmac("+201001234567");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(payerPhoneHmac("01001234567")).toBe(a);
    expect(payerPhoneHmac("00201001234567")).toBe(a);
    expect(payerPhoneHmac("01001234568")).not.toBe(a);
  });

  it("differs under a different SECRET_KEY", () => {
    const a = payerPhoneHmac("01001234567");
    process.env.SECRET_KEY = "another-secret-key-entirely-0000000000";
    expect(payerPhoneHmac("01001234567")).not.toBe(a);
  });

  it("an unparseable phone → null", () => {
    expect(payerPhoneHmac(null)).toBeNull();
    expect(payerPhoneHmac("")).toBeNull();
    expect(payerPhoneHmac("12345")).toBeNull();
    expect(payerPhoneHmac("0221xxxxxxxx")).toBeNull();
  });
});

describe("rawExpiresAt — the §4.10 retention table", () => {
  const now = new Date("2026-10-19T12:00:00.000Z");
  const plus = (d: number) => new Date(now.getTime() + d * DAY).toISOString();

  it("parsed 7 d · fallback / unknown_format 30 d · not_credit / too_old / duplicate / otp 2 d", () => {
    expect(rawExpiresAt("parsed", { now }).toISOString()).toBe(plus(7));
    expect(rawExpiresAt("fallback", { now }).toISOString()).toBe(plus(30));
    expect(rawExpiresAt("unknown_format", { now }).toISOString()).toBe(plus(30));
    for (const s of ["not_credit", "too_old", "duplicate", "otp"] as const) {
      expect(rawExpiresAt(s, { now }).toISOString(), s).toBe(plus(2));
    }
  });

  it("test → 1 d whatever the status", () => {
    expect(rawExpiresAt("parsed", { now, test: true }).toISOString()).toBe(plus(1));
    expect(rawExpiresAt("unknown_format", { now, test: true }).toISOString()).toBe(plus(1));
  });

  it("shared wins over test and status: shared_at + 90 d", () => {
    const sharedAt = "2026-10-01T00:00:00.000Z";
    const want = new Date(Date.parse(sharedAt) + 90 * DAY).toISOString();
    expect(rawExpiresAt("unknown_format", { now, test: true, sharedAt }).toISOString()).toBe(want);
    expect(rawExpiresAt("parsed", { now, sharedAt: new Date(sharedAt) }).toISOString()).toBe(want);
  });
});
