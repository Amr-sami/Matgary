/**
 * Doc 14 R25 — a return may not exceed what the sale line sold, less what
 * earlier returns already took back. `recordReturn` (lib/repo/operations.ts,
 * the function POST /api/returns calls) used to credit whatever quantity the
 * caller sent — 99 against a sale of 1 — with allowNegative on the stock
 * adjust; tests/e2e/sale-return.spec.ts pinned that.
 *
 * The DB is faked with a drizzle-shaped tx that scripts each read and records
 * every write, so the assertions are about the repo's own contract:
 *   - over the cap → DomainError RETURN_EXCEEDS_SOLD (400) carrying the line
 *     id and the remaining quantity, and NOTHING is written — no stock
 *     credit, no sales update, no returns row, no history;
 *   - the cap is cumulative: quantitySold − Σ(returns.returned_quantity);
 *   - exactly the remainder is accepted, and `sales.returned_quantity` is
 *     kept as the running total (it used to be overwritten per return);
 *   - a fully returned line refuses even 1 (maxQty 0);
 *   - the sale row is read FOR UPDATE so two returns serialise.
 */
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const C = vi.hoisted(() => ({
  TENANT: "11111111-1111-4111-8111-111111111111",
  SALE: "44444444-4444-4444-8444-444444444444",
  PRODUCT: "55555555-5555-4555-8555-555555555555",
  BRANCH: "33333333-3333-4333-8333-333333333333",
}));

// ─── fakes ───────────────────────────────────────────────────────────────────

const fake = vi.hoisted(() => {
  const state = {
    /** Scripted results, one per awaited select, in query order. */
    reads: [] as unknown[][],
    /** Every select's table plus the lock strength it asked for. */
    selects: [] as Array<{ table: string; lock: string | null }>,
    updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
    inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  };
  const name = (t: unknown) => getTableName(t as Parameters<typeof getTableName>[0]);
  const thenable = (result: () => unknown) => ({
    then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
      try {
        resolve(result());
      } catch (e) {
        reject(e);
      }
    },
  });
  const tx = {
    select: () => {
      const q = { table: "", lock: null as string | null };
      const b: Record<string, unknown> = {
        ...thenable(() => {
          const next = state.reads.shift();
          if (!next) throw new Error(`unexpected select on ${q.table}`);
          return next;
        }),
      };
      b.from = (t: unknown) => {
        q.table = name(t);
        state.selects.push(q);
        return b;
      };
      b.where = () => b;
      b.limit = () => b;
      b.for = (strength: string) => {
        q.lock = strength;
        return b;
      };
      return b;
    },
    update: (t: unknown) => ({
      set: (set: Record<string, unknown>) => {
        state.updates.push({ table: name(t), set });
        return { where: () => thenable(() => undefined) };
      },
    }),
    insert: (t: unknown) => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push({ table: name(t), values });
        const done = thenable(() => undefined);
        return { ...done, returning: () => thenable(() => [{ id: "ret-1" }]) };
      },
    }),
  };
  return { state, tx };
});

vi.mock("@/lib/db", () => ({
  db: fake.tx,
  withTenant: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx)),
}));
vi.mock("@/lib/repo/insights", () => ({ bustInsightsCache: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/dispatch", () => ({ fanoutEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/repo/loyalty", () => ({
  applyCredit: vi.fn(),
  earnPoints: vi.fn(),
  redeemPoints: vi.fn(),
}));
vi.mock("@/lib/observability/tracing", () => ({
  withSpan: vi.fn(async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { isDomainError } from "@/lib/errors";
import { recordReturn } from "@/lib/repo/operations";

const saleRow = (quantitySold: number) => ({
  id: C.SALE,
  tenantId: C.TENANT,
  productId: C.PRODUCT,
  productName: "ساعة",
  quantitySold,
  isReturned: false,
  returnedQuantity: null,
});

/** Script: the sale row, then Σ(returns) for it, then (if it gets that far) the product row. */
function script(quantitySold: number, alreadyReturned: number, stock = 4) {
  fake.state.reads = [[saleRow(quantitySold)], [{ total: alreadyReturned }], [{ quantity: stock, branchId: C.BRANCH }]];
}

async function attempt(returnedQuantity: number) {
  try {
    return await recordReturn(C.TENANT, { saleId: C.SALE, productId: C.PRODUCT, returnedQuantity, reason: "x" });
  } catch (err) {
    if (isDomainError(err)) return { code: err.code, status: err.httpStatus, detail: err.detail };
    throw err;
  }
}

beforeEach(() => {
  fake.state.reads = [];
  fake.state.selects = [];
  fake.state.updates = [];
  fake.state.inserts = [];
});

describe("recordReturn — R25 return cap", () => {
  it("99 against a sale of 1 → RETURN_EXCEEDS_SOLD {lineId, maxQty:1}, nothing written", async () => {
    script(1, 0);
    expect(await attempt(99)).toEqual({
      code: "RETURN_EXCEEDS_SOLD",
      status: 400,
      detail: { lineId: C.SALE, maxQty: 1 },
    });
    expect(fake.state.updates).toEqual([]);
    expect(fake.state.inserts).toEqual([]);
    // Refused from the sale + returns reads alone: the product was never touched.
    expect(fake.state.selects.map((s) => s.table)).toEqual(["sales", "returns"]);
  });

  it("the cap is cumulative: 3 sold, 2 already returned → 2 is refused with maxQty 1", async () => {
    script(3, 2);
    expect(await attempt(2)).toMatchObject({ code: "RETURN_EXCEEDS_SOLD", detail: { lineId: C.SALE, maxQty: 1 } });
    expect(fake.state.updates).toEqual([]);
    expect(fake.state.inserts).toEqual([]);
  });

  it("a fully returned line refuses even 1 (maxQty 0)", async () => {
    script(2, 2);
    expect(await attempt(1)).toMatchObject({ code: "RETURN_EXCEEDS_SOLD", detail: { maxQty: 0 } });
    expect(fake.state.updates).toEqual([]);
  });

  it("exactly the remainder is accepted: stock credited, running total kept, returns + history rows written", async () => {
    script(3, 2, 4);
    expect(await attempt(1)).toEqual({ returnId: "ret-1" });

    expect(fake.state.updates).toEqual([
      { table: "products", set: expect.objectContaining({ quantity: 5 }) },
      { table: "sales", set: expect.objectContaining({ isReturned: true, returnedQuantity: 3 }) },
    ]);
    expect(fake.state.inserts.map((i) => i.table)).toEqual(["returns", "product_history"]);
    expect(fake.state.inserts[0]!.values).toMatchObject({
      tenantId: C.TENANT,
      saleId: C.SALE,
      productId: C.PRODUCT,
      returnedQuantity: 1,
    });
    expect(fake.state.inserts[1]!.values).toMatchObject({ type: "returned", delta: 1 });
  });

  it("a first full return of the whole line is accepted", async () => {
    script(2, 0, 8);
    expect(await attempt(2)).toEqual({ returnId: "ret-1" });
    expect(fake.state.updates[1]).toEqual({
      table: "sales",
      set: expect.objectContaining({ returnedQuantity: 2 }),
    });
  });

  it("reads the sale row FOR UPDATE so concurrent returns serialise on the cap", async () => {
    script(1, 0);
    await attempt(1);
    expect(fake.state.selects[0]).toEqual({ table: "sales", lock: "update" });
  });

  it("an unknown sale is still 'البيع غير موجود' (unchanged)", async () => {
    fake.state.reads = [[]];
    await expect(attempt(1)).rejects.toThrow("البيع غير موجود");
  });
});
