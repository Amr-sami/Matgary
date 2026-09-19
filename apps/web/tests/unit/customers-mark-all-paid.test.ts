/**
 * "Mark all paid" for a customer returned HTTP 500 on every call.
 *
 * Cause: `markCustomerAllPaid` (lib/repo/customers.ts) interpolated a JS
 * Date into a raw sql`` template — `paid_at = ${now}` — inside
 * `tx.execute`. A bare value in a raw template carries no column encoder,
 * and drizzle's postgres-js driver replaces the timestamptz serializer with
 * the identity function, so postgres.js was handed the Date object itself
 * and the socket writer threw ERR_INVALID_ARG_TYPE. Typed column writes
 * (`insert().values({ recordedAt: now })`, `lte(column, now)`) never hit
 * this because the column's mapToDriverValue stringifies first.
 *
 * The DB is faked with a drizzle-shaped tx that scripts the read and
 * captures every write. The captured SQL is compiled with the real
 * PgDialect so the assertions are about what would actually be bound:
 *   - no Date object among the bound params of the raw UPDATE (the bug);
 *   - `paid_at` is set from `now()` in SQL;
 *   - the UPDATE is keyed by the ids the SELECT returned, so the rows it
 *     flips are exactly the rows that get a sale_payments event — the
 *     SELECT matches every stored phone shape, the old equality on the
 *     E.164 form alone did not;
 *   - one payment event per row with an outstanding balance, for the
 *     delta actually collected, default method cash;
 *   - nothing is written when the customer has no unpaid rows.
 * A second block pins the same property on the other raw-template call
 * sites that were fixed alongside it (tenant-deletion, activity).
 */
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const C = vi.hoisted(() => ({
  TENANT: "11111111-1111-4111-8111-111111111111",
  BRANCH: "33333333-3333-4333-8333-333333333333",
  USER: "22222222-2222-4222-8222-222222222222",
  SALE_E164: "44444444-4444-4444-8444-444444444441",
  SALE_LOCAL: "44444444-4444-4444-8444-444444444442",
  SALE_SETTLED: "44444444-4444-4444-8444-444444444443",
  PHONE: "+201001234008",
}));

// ─── fakes ───────────────────────────────────────────────────────────────────

const fake = vi.hoisted(() => {
  const state = {
    /** Scripted results, one per awaited select, in query order. */
    reads: [] as unknown[][],
    /** Every `.where(...)` condition handed to a select, in order. */
    wheres: [] as unknown[],
    /** Every raw `tx.execute(sql)` call, in order. */
    executes: [] as unknown[],
    inserts: [] as Array<{ table: string; values: unknown }>,
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
      const b: Record<string, unknown> = {
        ...thenable(() => {
          const next = state.reads.shift();
          if (!next) throw new Error("unexpected select");
          return next;
        }),
      };
      b.from = () => b;
      b.where = (cond: unknown) => {
        state.wheres.push(cond);
        return b;
      };
      b.orderBy = () => b;
      b.limit = () => b;
      return b;
    },
    execute: (q: unknown) => {
      state.executes.push(q);
      return thenable(() => []);
    },
    insert: (t: unknown) => ({
      values: (values: unknown) => {
        state.inserts.push({ table: name(t), values });
        return thenable(() => undefined);
      },
    }),
  };
  return { state, tx };
});

vi.mock("@/lib/db", () => ({
  db: fake.tx,
  withTenant: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx)),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { markCustomerAllPaid } from "@/lib/repo/customers";
import { findDueDeletions } from "@/lib/repo/tenant-deletion";
import { listActivity } from "@/lib/repo/activity";

const dialect = new PgDialect();
const compile = (q: unknown) => dialect.sqlToQuery(q as SQL);

/** True for anything postgres.js can serialise without a type-specific
 *  serializer — i.e. what drizzle's postgres-js driver still handles once
 *  it has neutered the timestamp serializers. A Date is NOT in this set. */
const isPlainBindable = (p: unknown) =>
  p === null || ["string", "number", "boolean"].includes(typeof p);

beforeEach(() => {
  fake.state.reads = [];
  fake.state.wheres = [];
  fake.state.executes = [];
  fake.state.inserts = [];
});

// ─── markCustomerAllPaid ─────────────────────────────────────────────────────

describe("markCustomerAllPaid — raw UPDATE binds no Date", () => {
  /** Three unpaid rows: one stored E.164, one stored local-form (legacy
   *  POST /api/sales writer), one already partly paid. */
  function scriptDebtor() {
    fake.state.reads = [
      [
        { id: C.SALE_E164, totalPrice: "300.00", amountPaid: "0.00", invoiceId: "inv-1" },
        { id: C.SALE_LOCAL, totalPrice: "150.00", amountPaid: null, invoiceId: null },
        { id: C.SALE_SETTLED, totalPrice: "100.00", amountPaid: "60.00", invoiceId: "inv-2" },
      ],
    ];
  }

  it("does not put a Date object among the bound params (the ERR_INVALID_ARG_TYPE 500)", async () => {
    scriptDebtor();
    await markCustomerAllPaid(C.TENANT, C.BRANCH, C.PHONE, { recordedByUserId: C.USER });

    expect(fake.state.executes).toHaveLength(1);
    const { sql: text, params } = compile(fake.state.executes[0]);
    expect(text).toMatch(/UPDATE sales/);
    for (const p of params) {
      expect(p, `bound param ${String(p)} must not be a Date`).not.toBeInstanceOf(Date);
      expect(isPlainBindable(p), `bound param ${String(p)} is not plainly bindable`).toBe(true);
    }
  });

  it("sets paid_at from now() in SQL and clears partial_paid_at", async () => {
    scriptDebtor();
    await markCustomerAllPaid(C.TENANT, C.BRANCH, C.PHONE, { recordedByUserId: C.USER });

    const { sql: text } = compile(fake.state.executes[0]);
    expect(text).toMatch(/paid_at\s*=\s*now\(\)/);
    expect(text).toMatch(/partial_paid_at\s*=\s*NULL/);
    expect(text).toMatch(/is_paid\s*=\s*true/);
    expect(text).toMatch(/amount_paid\s*=\s*CAST\(total_price AS numeric\(14,2\)\)/);
  });

  it("keys the UPDATE by the ids the SELECT returned, not by one phone spelling", async () => {
    scriptDebtor();
    await markCustomerAllPaid(C.TENANT, C.BRANCH, C.PHONE, { recordedByUserId: C.USER });

    const { sql: text, params } = compile(fake.state.executes[0]);
    expect(text).toMatch(/id IN \(/);
    expect(params).toEqual(expect.arrayContaining([C.SALE_E164, C.SALE_LOCAL, C.SALE_SETTLED]));
    // The E.164 equality is what left legacy local-form rows unpaid while a
    // payment event was still recorded for them.
    expect(text).not.toMatch(/customer_phone\s*=/);
    // RLS belt-and-braces stays.
    expect(params).toContain(C.TENANT);
  });

  it("records one cash payment event per row for the delta actually collected", async () => {
    scriptDebtor();
    const result = await markCustomerAllPaid(C.TENANT, C.BRANCH, C.PHONE, { recordedByUserId: C.USER });

    expect(result).toEqual({ markedCount: 3, markedTotal: 300 + 150 + 40 });
    expect(fake.state.inserts).toHaveLength(1);
    expect(fake.state.inserts[0].table).toBe("sale_payments");
    const events = fake.state.inserts[0].values as Array<Record<string, unknown>>;
    expect(events.map((e) => [e.saleId, e.amount, e.method, e.recordedByUserId])).toEqual([
      [C.SALE_E164, "300", "cash", C.USER],
      [C.SALE_LOCAL, "150", "cash", C.USER],
      [C.SALE_SETTLED, "40", "cash", C.USER],
    ]);
    // Typed column write — a Date is fine here, the column encoder maps it.
    for (const e of events) expect(e.recordedAt).toBeInstanceOf(Date);
  });

  it("honours an explicit settlement method", async () => {
    scriptDebtor();
    await markCustomerAllPaid(C.TENANT, C.BRANCH, C.PHONE, {
      recordedByUserId: C.USER,
      method: "instapay",
    });
    const events = fake.state.inserts[0].values as Array<Record<string, unknown>>;
    expect(new Set(events.map((e) => e.method))).toEqual(new Set(["instapay"]));
  });

  it("writes nothing when the customer has no unpaid rows", async () => {
    fake.state.reads = [[]];
    const result = await markCustomerAllPaid(C.TENANT, C.BRANCH, C.PHONE, { recordedByUserId: C.USER });
    expect(result).toEqual({ markedCount: 0, markedTotal: 0 });
    expect(fake.state.executes).toHaveLength(0);
    expect(fake.state.inserts).toHaveLength(0);
  });
});

// ─── the same bug class elsewhere ────────────────────────────────────────────

describe("other raw-template call sites bind Dates through the column encoder", () => {
  it("findDueDeletions compares deletion_scheduled_at to an ISO string, not a Date", async () => {
    fake.state.reads = [[{ count: 2 }]];
    const now = new Date("2026-09-19T12:00:00.000Z");
    await expect(findDueDeletions(now)).resolves.toBe(2);

    expect(fake.state.wheres).toHaveLength(1);
    const { sql: text, params } = compile(fake.state.wheres[0]);
    expect(text).toMatch(/deletion_scheduled_at/);
    for (const p of params) expect(p).not.toBeInstanceOf(Date);
    expect(params).toContain(now.toISOString());
  });

  it("listActivity's `before` keyset bound is an ISO string, not a Date", async () => {
    fake.state.reads = [[]];
    const before = new Date("2026-09-19T12:00:00.000Z");
    await expect(listActivity(C.TENANT, { before })).resolves.toEqual([]);

    expect(fake.state.wheres).toHaveLength(1);
    const { sql: text, params } = compile(fake.state.wheres[0]);
    expect(text).toMatch(/created_at/);
    for (const p of params) expect(p).not.toBeInstanceOf(Date);
    expect(params).toContain(before.toISOString());
  });
});
