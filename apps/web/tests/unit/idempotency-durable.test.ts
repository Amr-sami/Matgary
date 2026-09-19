/**
 * Doc 14 §10 M3 — durable idempotency for POST /api/sales/cart.
 *
 * Two halves, both pinned here:
 *   1. The Redis entry is bound to (user, body) through a fingerprint, so a
 *      different write reusing a key is 409 IDEMPOTENCY_MISMATCH instead of
 *      silently receiving the other write's 201.
 *   2. The key also lands on the cart's anchor `sales` row under the partial
 *      unique index of migration 0054; the route maps that 23505 back to the
 *      existing cart — same user, same lines — or 409 otherwise.
 *
 * Pure functions + source pins; the DB half needs a "test" database, which
 * this harness does not name, so the index itself is exercised by migration
 * (applied locally) rather than here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  IDEMPOTENCY_MISMATCH_BODY,
  SALES_IDEMPOTENCY_INDEX,
  canonicalJson,
  classifyLookup,
  idempotencyCacheKey,
  isUniqueViolation,
  requestFingerprint,
  sameCart,
  validateIdempotencyKey,
} from "@/lib/api/idempotency";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("key builder", () => {
  it("scopes by tenant and key, and the fingerprint is NOT part of the key", () => {
    const k = idempotencyCacheKey("t1", "abc-123");
    expect(k).toContain(":idemp:t1:abc-123");
    expect(idempotencyCacheKey("t2", "abc-123")).not.toBe(k);
    // Same key regardless of who/what — the fingerprint lives in the value
    // so a mismatching replay finds the entry and gets refused.
    expect(idempotencyCacheKey("t1", "abc-123")).toBe(k);
  });

  it("validateIdempotencyKey keeps the existing contract", () => {
    expect(validateIdempotencyKey("3f2a1b7c-9d4e-4f6a-8b1c-2d3e4f5a6b7c")).toBe(
      "3f2a1b7c-9d4e-4f6a-8b1c-2d3e4f5a6b7c",
    );
    expect(validateIdempotencyKey("short")).toBeNull();
    expect(validateIdempotencyKey("has spaces here")).toBeNull();
    expect(validateIdempotencyKey(null)).toBeNull();
  });
});

describe("requestFingerprint", () => {
  const body = { lines: [{ productId: P1, quantity: 2 }], options: { note: "x" } };

  it("is stable across property order", () => {
    const reordered = { options: { note: "x" }, lines: [{ quantity: 2, productId: P1 }] };
    expect(requestFingerprint(U1, body)).toBe(requestFingerprint(U1, reordered));
    expect(canonicalJson(body)).toBe(canonicalJson(reordered));
  });

  it("changes with the user", () => {
    expect(requestFingerprint(U1, body)).not.toBe(requestFingerprint(U2, body));
  });

  it("changes with the body — even one quantity", () => {
    const other = { ...body, lines: [{ productId: P1, quantity: 3 }] };
    expect(requestFingerprint(U1, body)).not.toBe(requestFingerprint(U1, other));
  });

  it("array order matters (a reordered cart is a different cart)", () => {
    const a = { lines: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 1 }] };
    const b = { lines: [{ productId: P2, quantity: 1 }, { productId: P1, quantity: 1 }] };
    expect(requestFingerprint(U1, a)).not.toBe(requestFingerprint(U1, b));
  });

  it("is a 64-hex sha256 and tolerates a null body", () => {
    expect(requestFingerprint(U1, null)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestFingerprint(U1, undefined)).toBe(requestFingerprint(U1, null));
  });
});

describe("classifyLookup", () => {
  const fp = requestFingerprint(U1, { a: 1 });
  const entry = { status: 201, body: { ok: true }, at: 1, fingerprint: fp };

  it("miss on no entry", () => {
    expect(classifyLookup(null, fp)).toEqual({ kind: "miss" });
  });

  it("replay on the same fingerprint", () => {
    expect(classifyLookup(entry, fp)).toEqual({ kind: "replay", cached: entry });
  });

  it("mismatch on a different fingerprint", () => {
    const r = classifyLookup(entry, requestFingerprint(U2, { a: 1 }));
    expect(r.kind).toBe("mismatch");
  });

  it("legacy entry without a fingerprint replays unconditionally", () => {
    const legacy = { status: 201, body: {}, at: 1 };
    expect(classifyLookup(legacy, fp).kind).toBe("replay");
  });

  it("the 409 body is the documented one", () => {
    expect(IDEMPOTENCY_MISMATCH_BODY).toEqual({ error: "IDEMPOTENCY_MISMATCH" });
  });
});

describe("isUniqueViolation (pg 23505 mapping)", () => {
  it("matches a postgres.js error on the named index", () => {
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: SALES_IDEMPOTENCY_INDEX,
    });
    expect(isUniqueViolation(err, SALES_IDEMPOTENCY_INDEX)).toBe(true);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("matches when drizzle wraps the driver error in `cause`", () => {
    const cause = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: SALES_IDEMPOTENCY_INDEX,
    });
    const wrapped = Object.assign(new Error("Failed query"), { cause });
    expect(isUniqueViolation(wrapped, SALES_IDEMPOTENCY_INDEX)).toBe(true);
  });

  it("does not match a unique violation on another index", () => {
    const err = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "auth_devices_user_install_live_idx",
    });
    expect(isUniqueViolation(err, SALES_IDEMPOTENCY_INDEX)).toBe(false);
  });

  it("does not match other codes, plain errors, or non-objects", () => {
    expect(isUniqueViolation(Object.assign(new Error("rls"), { code: "42501" }))).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("sameCart (durable-path mismatch check)", () => {
  const booked = {
    userId: U1,
    lines: [
      { productId: P1, quantity: 2 },
      { productId: P2, quantity: 1 },
    ],
  };

  it("same user + same lines in any order → same", () => {
    expect(sameCart(booked, { userId: U1, lines: [...booked.lines].reverse() })).toBe(true);
  });

  it("different user → not same", () => {
    expect(sameCart(booked, { ...booked, userId: U2 })).toBe(false);
  });

  it("different quantity / product / line count → not same", () => {
    expect(sameCart(booked, { userId: U1, lines: [{ productId: P1, quantity: 3 }, { productId: P2, quantity: 1 }] })).toBe(false);
    expect(sameCart(booked, { userId: U1, lines: [{ productId: P1, quantity: 2 }] })).toBe(false);
    expect(sameCart(booked, { userId: U1, lines: [...booked.lines, { productId: P1, quantity: 1 }] })).toBe(false);
  });

  it("duplicate lines are a multiset, not a set", () => {
    const twice = { userId: U1, lines: [{ productId: P1, quantity: 1 }, { productId: P1, quantity: 1 }] };
    const once = { userId: U1, lines: [{ productId: P1, quantity: 1 }] };
    expect(sameCart(twice, once)).toBe(false);
    expect(sameCart(twice, { ...twice })).toBe(true);
  });
});

/** Pinned from SOURCE (see route-gates.test.ts for why): the route wires
 *  both halves, and the schema/migration carry the index by that name. */
describe("wiring", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

  it("the cart route fingerprints, refuses mismatches, writes the key and maps 23505", () => {
    const src = read("app/api/sales/cart/route.ts");
    expect(src).toContain("requestFingerprint(r.ctx.userId, body)");
    expect(src).toContain('hit.kind === "mismatch"');
    expect(src).toContain("IDEMPOTENCY_MISMATCH_BODY, { status: 409 }");
    expect(src).toContain("idempotencyKey: idemp ?? undefined");
    expect(src).toContain("isUniqueViolation(err, SALES_IDEMPOTENCY_INDEX)");
    expect(src).toContain("findCartSaleByIdempotencyKey(r.ctx.tenantId, idemp)");
    expect(src).toContain("rememberResponse(r.ctx.tenantId, idemp, 201, result, fingerprint)");
  });

  it("recordCartSale writes the key on the anchor row only", () => {
    const src = read("lib/repo/operations.ts");
    expect(src).toContain("idempotencyKey: i === 0 ? options.idempotencyKey ?? null : null");
  });

  it("schema + migration 0054 + journal agree on the index", () => {
    const schema = read("lib/db/schema.ts");
    expect(schema).toContain(`uniqueIndex("${SALES_IDEMPOTENCY_INDEX}")`);
    expect(schema).toContain('idempotencyKey: text("idempotency_key")');
    const sql = read("lib/db/migrations/0054_sales_idempotency_key.sql");
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${SALES_IDEMPOTENCY_INDEX}"`);
    expect(sql).toContain('WHERE "idempotency_key" IS NOT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "idempotency_key" text');
    const journal = JSON.parse(read("lib/db/migrations/meta/_journal.json")) as {
      entries: { idx: number; tag: string }[];
    };
    const last = journal.entries[journal.entries.length - 1]!;
    expect(last).toMatchObject({ idx: 54, tag: "0054_sales_idempotency_key" });
  });
});
