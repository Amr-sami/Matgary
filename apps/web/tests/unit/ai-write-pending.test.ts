/**
 * F5 — pending-action HMAC / canonical-JSON unit tests.
 *
 * These are pure-function tests: no DB, no network. They lock down the
 * signing contract so a future refactor can't silently change what the HMAC
 * covers (which would invalidate every live pending row at deploy time).
 *
 * Full lifecycle tests (createPending → consumePending → execute) live in the
 * live smoke script (scripts/smoke-ai-f5.ts) because they need Postgres +
 * Gemini.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { canonicalJson, signPending } from "@/lib/ai/write/pending";

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("recurses into nested objects", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 2, 1] })).toBe(
      '{"a":[3,2,1],"z":{"x":2,"y":1}}',
    );
  });

  it("produces identical output for the same input", () => {
    const a = { newPrice: 2500, productId: "abc" };
    const b = { productId: "abc", newPrice: 2500 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("round-trips primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("signPending", () => {
  const sampleRow = {
    id: "00000000-0000-0000-0000-000000000001",
    tenantId: "00000000-0000-0000-0000-00000000aaaa",
    userId: "00000000-0000-0000-0000-00000000bbbb",
    branchId: "00000000-0000-0000-0000-00000000cccc",
    action: "update_product_price",
    params: { productId: "p-1", newPrice: 2500 },
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };

  it("produces a stable 64-hex-char SHA-256 output", () => {
    const h = signPending("secret", sampleRow);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("equals a manual HMAC over the same canonical message", () => {
    const expected = createHmac("sha256", "secret")
      .update(
        [
          sampleRow.id,
          sampleRow.tenantId,
          sampleRow.userId,
          sampleRow.branchId,
          sampleRow.action,
          '{"newPrice":2500,"productId":"p-1"}',
          sampleRow.expiresAt.toISOString(),
        ].join("|"),
      )
      .digest("hex");
    expect(signPending("secret", sampleRow)).toBe(expected);
  });

  it("changes when params change (tamper detection)", () => {
    const h1 = signPending("secret", sampleRow);
    const h2 = signPending("secret", { ...sampleRow, params: { ...sampleRow.params, newPrice: 5000 } });
    expect(h2).not.toBe(h1);
  });

  it("changes when action changes (cross-action replay guard)", () => {
    const h1 = signPending("secret", sampleRow);
    const h2 = signPending("secret", { ...sampleRow, action: "update_product_quantity" });
    expect(h2).not.toBe(h1);
  });

  it("changes when tenant changes (cross-tenant replay guard)", () => {
    const h1 = signPending("secret", sampleRow);
    const h2 = signPending("secret", { ...sampleRow, tenantId: "00000000-0000-0000-0000-00000000ffff" });
    expect(h2).not.toBe(h1);
  });

  it("changes when user changes", () => {
    const h1 = signPending("secret", sampleRow);
    const h2 = signPending("secret", { ...sampleRow, userId: "00000000-0000-0000-0000-00000000eeee" });
    expect(h2).not.toBe(h1);
  });

  it("changes when expiry changes (no extending via replay)", () => {
    const h1 = signPending("secret", sampleRow);
    const h2 = signPending("secret", { ...sampleRow, expiresAt: new Date("2031-01-01T00:00:00.000Z") });
    expect(h2).not.toBe(h1);
  });

  it("changes when secret changes (rotation invalidates old tokens)", () => {
    const h1 = signPending("secret", sampleRow);
    const h2 = signPending("rotated", sampleRow);
    expect(h2).not.toBe(h1);
  });

  it("is order-independent for params (canonical JSON stabilises)", () => {
    const h1 = signPending("secret", { ...sampleRow, params: { a: 1, b: 2 } });
    const h2 = signPending("secret", { ...sampleRow, params: { b: 2, a: 1 } });
    expect(h2).toBe(h1);
  });
});

describe("token shape (F5.1 §2 — full-length HMAC)", () => {
  it("produces a 64-hex-char HMAC — enough entropy for an ERP mutation token", () => {
    const row = {
      id: "00000000-0000-0000-0000-000000000001",
      tenantId: "00000000-0000-0000-0000-00000000aaaa",
      userId: "00000000-0000-0000-0000-00000000bbbb",
      branchId: null,
      action: "update_product_price",
      params: { productId: "p-1", newPrice: 2500 },
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const h = signPending("secret", row);
    // SHA-256 hex digest is always 64 chars.
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
