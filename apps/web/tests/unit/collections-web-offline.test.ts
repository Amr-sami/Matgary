/**
 * Digital collections — the web POS offline path carries the transfer fields
 * (doc 15 spec 12 §4.4, §7): lib/offline/recordCartSale.ts posts them inside
 * `options` under one Idempotency-Key, returns the server's collectionStatus /
 * collectionIds, and queues the byte-identical payload when offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.fn(async (input: unknown) => (input ? 1 : 0));
const decrementSnapshotStock = vi.fn(async () => undefined);

vi.mock("@/lib/offline/outbox", () => ({ enqueue: (i: unknown) => enqueue(i) }));
vi.mock("@/lib/offline/snapshot", () => ({ decrementSnapshotStock: () => decrementSnapshotStock() }));

import { recordCartSaleOfflineAware } from "@/lib/offline/recordCartSale";

const ctx = { tenantId: "t1", branchId: "b1" };
const lines = [{ productId: "p1", quantity: 2, pricePerUnit: 75 }];
const PARTS = [
  { accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", amount: 100, payerPhoneLast4: "1234" },
  { accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", amount: 20, payerReference: "ab12cd" },
];

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let answer: { status: number; body: unknown } = { status: 201, body: {} };

function setOnline(onLine: boolean) {
  Object.defineProperty(globalThis, "navigator", { value: { onLine }, configurable: true, writable: true });
}

beforeEach(() => {
  calls = [];
  enqueue.mockClear();
  decrementSnapshotStock.mockClear();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordCartSaleOfflineAware — collection fields", () => {
  it("posts the single-transfer fields inside options, with an Idempotency-Key", async () => {
    setOnline(true);
    answer = {
      status: 201,
      body: { invoiceId: "INV-1", saleIds: ["s1"], collectionStatus: "pending", collectionIds: ["a", "b"] },
    };
    const r = await recordCartSaleOfflineAware(ctx, lines, {
      paymentMethod: "wallet",
      collectionAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      payerPhoneLast4: "1234",
      payerReference: "Ab12Cd",
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/.{8,}/);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.options).toMatchObject({
      paymentMethod: "wallet",
      collectionAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      payerPhoneLast4: "1234",
      payerReference: "Ab12Cd",
    });
    expect(r).toEqual({
      invoiceId: "INV-1",
      saleIds: ["s1"],
      synced: true,
      collectionStatus: "pending",
      collectionIds: ["a", "b"],
    });
  });

  it("posts collectionParts exactly as passed", async () => {
    setOnline(true);
    answer = { status: 201, body: { invoiceId: "INV-2", saleIds: ["s2"], collectionStatus: "pending", collectionIds: ["x", "y"] } };
    await recordCartSaleOfflineAware(ctx, lines, { paymentMethod: "instapay", collectionParts: PARTS });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.options.collectionParts).toEqual(PARTS);
    expect(body.options.collectionAccountId).toBeUndefined();
  });

  it("an older server without the fields → null / []", async () => {
    setOnline(true);
    answer = { status: 201, body: { invoiceId: "INV-3", saleIds: ["s3"] } };
    const r = await recordCartSaleOfflineAware(ctx, lines, { paymentMethod: "cash" });
    expect(r.collectionStatus).toBeNull();
    expect(r.collectionIds).toEqual([]);
  });

  it("offline → enqueue with the same payload; result synced false, null / []", async () => {
    setOnline(false);
    const r = await recordCartSaleOfflineAware(ctx, lines, {
      paymentMethod: "wallet",
      collectionParts: PARTS,
      payerPhoneLast4: undefined,
    });
    expect(calls).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0] as {
      type: string;
      idempotencyKey: string;
      payload: { lines: unknown; options: Record<string, unknown> };
    };
    expect(input.type).toBe("sale");
    expect(input.idempotencyKey).toMatch(/.{8,}/);
    expect(input.payload.lines).toEqual(lines);
    expect(input.payload.options.collectionParts).toEqual(PARTS);
    expect(input.payload.options.paymentMethod).toBe("wallet");
    expect(r).toMatchObject({ synced: false, collectionStatus: null, collectionIds: [] });
    expect(r.invoiceId).toBe(input.payload.options.invoiceId);
  });

  it("a network failure falls back to the outbox with the SAME key and payload", async () => {
    setOnline(true);
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      throw new TypeError("Failed to fetch");
    });
    await recordCartSaleOfflineAware(ctx, lines, {
      paymentMethod: "wallet",
      collectionAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(calls).toHaveLength(1);
    const sentKey = (calls[0].init.headers as Record<string, string>)["Idempotency-Key"];
    const input = enqueue.mock.calls[0][0] as { idempotencyKey: string; payload: unknown };
    expect(input.idempotencyKey).toBe(sentKey);
    expect(JSON.stringify(input.payload)).toBe(String(calls[0].init.body));
  });
});
