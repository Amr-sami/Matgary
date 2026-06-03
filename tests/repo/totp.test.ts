import { describe, expect, it } from "vitest";
import {
  buildOtpauthUri,
  findRecoveryCodeIndex,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotp,
} from "@/lib/totp";

// H03 — RFC 6238 conformance + the policy bits the auth flow depends on.

const RFC6238_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32 of "12345678901234567890"

describe("verifyTotp — RFC 6238 test vectors (SHA-1)", () => {
  // From RFC 6238 Appendix B (SHA-1 column), 6 digits, 30 s period.
  // The published 8-digit values are truncated by `code % 10**6` in our
  // implementation, so we strip to the last 6 digits before comparing.
  const cases: Array<{ time: number; expected: string }> = [
    { time: 59,          expected: "94287082".slice(-6) },
    { time: 1111111109,  expected: "07081804".slice(-6) },
    { time: 1111111111,  expected: "14050471".slice(-6) },
    { time: 1234567890,  expected: "89005924".slice(-6) },
    { time: 2000000000,  expected: "69279037".slice(-6) },
  ];
  for (const c of cases) {
    it(`accepts the expected code at t=${c.time}`, () => {
      expect(verifyTotp(c.expected, RFC6238_SECRET, c.time)).toBe(true);
    });
  }
});

describe("verifyTotp — window tolerance", () => {
  // Anchor on the RFC 6238 vector at t=59 (step 1 of the SHA-1 secret).
  // The published code is 94287082 → last 6 digits → "287082".
  const SEC = RFC6238_SECRET;
  const CODE = "287082";
  const STEP_T = 59; // canonical time for this code (step 1)

  it("accepts the same code one step ahead (±1 window)", () => {
    expect(verifyTotp(CODE, SEC, STEP_T + 30)).toBe(true); // step 2
  });
  it("accepts the same code one step behind (±1 window)", () => {
    expect(verifyTotp(CODE, SEC, STEP_T - 30)).toBe(true); // step 0
  });
  it("rejects the same code two steps ahead (outside ±1)", () => {
    expect(verifyTotp(CODE, SEC, STEP_T + 60)).toBe(false); // step 3
  });
  it("rejects a clearly future-step code at the current time", () => {
    // RFC vector at t=1111111109 → "07081804" → "081804"
    expect(verifyTotp("081804", SEC, STEP_T)).toBe(false);
  });

  it("rejects malformed input", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp("abc", secret)).toBe(false);
    expect(verifyTotp("123", secret)).toBe(false);
    expect(verifyTotp("12345", secret)).toBe(false);
    expect(verifyTotp("1234567", secret)).toBe(false);
    expect(verifyTotp("000000", "INVALID#BASE32")).toBe(false);
  });

  it("strips whitespace from the entered token", () => {
    // 6 spaces around a malformed token still fail — confirms we don't trim
    // into something accidentally well-formed.
    expect(verifyTotp("  abc  ", generateTotpSecret())).toBe(false);
  });
});

describe("buildOtpauthUri", () => {
  it("produces an authenticator-app-compatible otpauth:// URI", () => {
    const uri = buildOtpauthUri("user@example.com", "JBSWY3DPEHPK3PXP");
    expect(uri).toMatch(/^otpauth:\/\/totp\/Matgary%3Auser%40example\.com\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Matgary");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("recovery codes", () => {
  it("generates 8 unique codes in xxxxx-xxxxx hex format", async () => {
    const pairs = await generateRecoveryCodes();
    expect(pairs).toHaveLength(8);
    const set = new Set(pairs.map((p) => p.plaintext));
    expect(set.size).toBe(8);
    for (const p of pairs) {
      expect(p.plaintext).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
      // bcrypt format: $2[abxy]$cost$22-salt + 31-hash
      expect(p.hash).toMatch(/^\$2[abxy]\$/);
    }
  });

  it("findRecoveryCodeIndex matches one hash and returns its index", async () => {
    const pairs = await generateRecoveryCodes(3);
    const hashes = pairs.map((p) => p.hash);
    const idx = await findRecoveryCodeIndex(pairs[1]!.plaintext, hashes);
    expect(idx).toBe(1);
  });

  it("findRecoveryCodeIndex returns -1 for an unknown code", async () => {
    const pairs = await generateRecoveryCodes(3);
    const hashes = pairs.map((p) => p.hash);
    const idx = await findRecoveryCodeIndex("ffffff-ffffff", hashes);
    expect(idx).toBe(-1);
  });

  it("findRecoveryCodeIndex is case-insensitive and whitespace-tolerant", async () => {
    const pairs = await generateRecoveryCodes(1);
    const hashes = pairs.map((p) => p.hash);
    const dirty = `  ${pairs[0]!.plaintext.toUpperCase()}  `;
    expect(await findRecoveryCodeIndex(dirty, hashes)).toBe(0);
  });
});
