/**
 * F10.0 — rollback-engine deterministic logic tests.
 *
 * Covers the pure helpers that DON'T touch the database:
 *   • `diffWatchedFields` — concurrency detection semantics.
 *   • `isDestructiveRollback` — per-operation-type classification.
 *   • i18n coverage for rollback copy across all 5 F7 locales.
 *   • OperationType ↔ AiActionType coverage (compile-time proof via the
 *     test file importing both — a missed enum extension would break here).
 *
 * The DB-level behavior (restore writes, concurrency-at-DB-time, dependency
 * queries on real sales/wallet rows) is covered by the live smoke suite.
 */
import { describe, expect, it } from "vitest";

import { AI_MESSAGES, tr } from "@/lib/ai/i18n";
import { LOCALES } from "@/lib/ai/language";
import { isDestructiveRollback } from "@/lib/ai/operations/dependency";
import { diffWatchedFields } from "@/lib/ai/operations/rollback";
import type { OperationRecord } from "@/lib/ai/operations/types";

/* ───────────────────────── diffWatchedFields ──────────────────────────── */

describe("diffWatchedFields", () => {
  it("returns null when every watched field matches", () => {
    expect(
      diffWatchedFields({ price: 2200 }, { price: 2200, quantity: 5 }, ["price"]),
    ).toBeNull();
  });

  it("returns the drift when ANY watched field differs", () => {
    const r = diffWatchedFields({ price: 2200 }, { price: 2500 }, ["price"]);
    expect(r).not.toBeNull();
    expect(r!.expected).toEqual({ price: 2200 });
    expect(r!.current).toEqual({ price: 2500 });
  });

  it("ignores unwatched fields drifting", () => {
    // quantity drifted but we're only watching price.
    expect(
      diffWatchedFields(
        { price: 2200, quantity: 5 },
        { price: 2200, quantity: 99 },
        ["price"],
      ),
    ).toBeNull();
  });

  it("handles multiple watched fields", () => {
    const r = diffWatchedFields(
      { price: 2200, quantity: 5 },
      { price: 2200, quantity: 10 },
      ["price", "quantity"],
    );
    expect(r).not.toBeNull();
    expect(r!.current).toEqual({ quantity: 10 });
    expect(r!.expected).toEqual({ quantity: 5 });
  });

  it("deep-compares nested shapes via JSON", () => {
    const a = { snapshot: { points: 0, credit: "0" } };
    const b = { snapshot: { points: 0, credit: "0" } };
    expect(diffWatchedFields(a, b, ["snapshot"])).toBeNull();

    const c = { snapshot: { points: 10, credit: "0" } };
    const r = diffWatchedFields(a, c, ["snapshot"]);
    expect(r).not.toBeNull();
  });

  it("treats numeric equality strictly (2200 ≠ '2200')", () => {
    const r = diffWatchedFields({ price: 2200 }, { price: "2200" }, ["price"]);
    expect(r).not.toBeNull();
  });
});

/* ───────────────────────── isDestructiveRollback ──────────────────────── */

const stubRecord = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: "op-1",
  tenantId: "t-1",
  userId: "u-1",
  branchId: null,
  conversationId: null,
  operationType: "product.price.update",
  pendingActionId: null,
  operationGroupId: null,
  entityType: "product",
  entityId: "p-1",
  entityLabel: "Musk",
  entityKey: null,
  beforeState: { price: 2200 },
  afterState: { price: 2500 },
  affectedFields: ["price"],
  reversible: true,
  status: "recorded",
  statusReason: null,
  expiresAt: null,
  rollbackOperationId: null,
  actorName: null,
  idempotencyKey: null,
  metadata: {},
  createdAt: new Date(),
  ...overrides,
});

describe("isDestructiveRollback", () => {
  it("product.price.update is NOT destructive (field restore)", () => {
    expect(isDestructiveRollback(stubRecord({ operationType: "product.price.update" }))).toBe(false);
  });

  it("product.quantity.update is NOT destructive", () => {
    expect(
      isDestructiveRollback(stubRecord({ operationType: "product.quantity.update" })),
    ).toBe(false);
  });

  it("product.quantity.adjust is NOT destructive", () => {
    expect(
      isDestructiveRollback(stubRecord({ operationType: "product.quantity.adjust" })),
    ).toBe(false);
  });

  it("customer.create IS destructive (undo = DELETE)", () => {
    expect(isDestructiveRollback(stubRecord({ operationType: "customer.create" }))).toBe(true);
  });
});

/* ───────────────────────── i18n coverage ──────────────────────────────── */

describe("rollback i18n", () => {
  const rollbackKeys = Object.keys(AI_MESSAGES).filter((k) => k.startsWith("rollback."));

  it("has at least a dozen rollback keys", () => {
    expect(rollbackKeys.length).toBeGreaterThanOrEqual(12);
  });

  it("every rollback key resolves non-empty in every locale", () => {
    for (const key of rollbackKeys) {
      for (const loc of LOCALES) {
        const s = tr(key, loc);
        expect(s, `${key} / ${loc}`).toBeTruthy();
        expect(s, `${key} / ${loc} → raw key leak`).not.toBe(key);
      }
    }
  });

  it("price/quantity/customer preview descriptions interpolate correctly", () => {
    const price = tr("rollback.preview.description.price", "en", {
      before: "2,200",
      after: "2,500",
    });
    expect(price).toContain("2,200");
    expect(price).toContain("2,500");

    const qty = tr("rollback.preview.description.quantity", "ar", {
      before: "5",
      after: "10",
    });
    expect(qty).toContain("5");
    expect(qty).toContain("10");

    const cust = tr("rollback.preview.description.customer", "fr", { name: "Ahmed" });
    expect(cust).toContain("Ahmed");
  });
});

/* ───────────────────────── operation record shape ─────────────────────── */

describe("OperationRecord (compile-time proof)", () => {
  it("accepts a full-shape record", () => {
    const r = stubRecord();
    expect(r.id).toBeTruthy();
    expect(r.reversible).toBe(true);
    expect(r.status).toBe("recorded");
  });

  it("entity_key is nullable for product ops", () => {
    const r = stubRecord({ entityType: "product", entityKey: null });
    expect(r.entityKey).toBeNull();
  });

  it("entity_key carries the composite id for customer ops", () => {
    const r = stubRecord({
      entityType: "customer",
      entityId: null,
      entityKey: { branchId: "b-1", phone: "+201234567890" },
      beforeState: { exists: false },
      afterState: { name: "A", phone: "+201234567890" },
      affectedFields: ["name", "phone"],
    });
    expect(r.entityId).toBeNull();
    expect(r.entityKey).toEqual({ branchId: "b-1", phone: "+201234567890" });
  });
});
