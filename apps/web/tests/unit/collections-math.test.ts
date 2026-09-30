/**
 * Digital collections 05 §4.6 / §4.9 / §4.10 / §4.13 (step 8) — the pure
 * helpers in lib/collections/math.ts: normaliseParts, allocateRejection,
 * deriveInvoiceStatus, isStale, plus the IBAN validator the server uses (06's
 * domain `normalizeIban`, 03 §B.16 — the one validator for 05, 09 and 12).
 */
import { describe, expect, it } from "vitest";
import { normalizeIban } from "@matgary/domain/collections/normalize";
import {
  COLLECTION_STATUS_VALUES,
  type CollectionStatus,
} from "@matgary/domain/collections/types";
import {
  allocateRejection,
  deriveInvoiceStatus,
  fromPiasters,
  isStale,
  normaliseParts,
  roundToPiasters,
  toPiasters,
  type RejectionLine,
} from "@/lib/collections/math";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("roundToPiasters / toPiasters / fromPiasters", () => {
  it("rounds float noise and half-up decimals", () => {
    expect(roundToPiasters(0.1 + 0.2)).toBe(30);
    expect(roundToPiasters(1.005)).toBe(101);
    expect(roundToPiasters(33.333333)).toBe(3333);
    expect(roundToPiasters("150.50")).toBe(15050);
    expect(roundToPiasters(0)).toBe(0);
    expect(() => roundToPiasters(Number.NaN)).toThrow(RangeError);
  });

  it("re-exports the strict domain conversions", () => {
    expect(toPiasters("2,700.00")).toBe(270000);
    expect(fromPiasters(270000)).toBe("2700.00");
  });
});

describe("normaliseParts", () => {
  it("single transfer → one part = total, top-level account and payer hints", () => {
    const r = normaliseParts({ total: 250, collectionAccountId: A, payerPhoneLast4: "4321", payerReference: "AB12CD" });
    expect(r).toEqual({
      parts: [{ partNo: 1, accountId: A, amountPt: 25000, payerPhoneLast4: "4321", payerReference: "ab12cd" }],
      clamped: false,
      totalPt: 25000,
      cashRemainderPt: 0,
    });
  });

  it("single transfer without an account → accountId null (the repo picks the POS default)", () => {
    const r = normaliseParts({ total: 99.99 });
    expect(r.parts).toEqual([{ partNo: 1, accountId: null, amountPt: 9999, payerPhoneLast4: null, payerReference: null }]);
  });

  it("an empty collectionParts array is the single-transfer case", () => {
    const r = normaliseParts({ total: 10, collectionParts: [], collectionAccountId: B });
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.accountId).toBe(B);
  });

  it("two parts under the total keep order and leave a cash remainder", () => {
    const r = normaliseParts({
      total: 1000,
      collectionParts: [
        { accountId: A, amount: 600, payerReference: "XY99" },
        { accountId: B, amount: 300, payerPhoneLast4: "1111" },
      ],
    });
    expect(r.clamped).toBe(false);
    expect(r.parts.map((p) => [p.partNo, p.accountId, p.amountPt])).toEqual([
      [1, A, 60000],
      [2, B, 30000],
    ]);
    expect(r.parts[0]!.payerReference).toBe("xy99");
    expect(r.parts[1]!.payerPhoneLast4).toBe("1111");
    expect(r.cashRemainderPt).toBe(10000);
  });

  it("over the total clamps from the LAST part backwards and drops zeroed parts", () => {
    const r = normaliseParts({
      total: 100,
      collectionParts: [
        { accountId: A, amount: 80 },
        { accountId: B, amount: 30 },
        { accountId: C, amount: 25 },
        { accountId: D, amount: 5 },
      ],
    });
    // Σ = 140, excess 40: D 5→0 (dropped), C 25→0 (dropped), B 30→20.
    expect(r.clamped).toBe(true);
    expect(r.parts.map((p) => [p.partNo, p.accountId, p.amountPt])).toEqual([
      [1, A, 8000],
      [2, B, 2000],
    ]);
    expect(r.parts.reduce((s, p) => s + p.amountPt, 0)).toBe(r.totalPt);
    expect(r.cashRemainderPt).toBe(0);
  });

  it("a first part alone above the total is trimmed to the total", () => {
    const r = normaliseParts({ total: 50, collectionParts: [{ accountId: A, amount: 70 }] });
    expect(r.clamped).toBe(true);
    expect(r.parts).toEqual([{ partNo: 1, accountId: A, amountPt: 5000, payerPhoneLast4: null, payerReference: null }]);
  });

  it("drops non-positive parts before numbering", () => {
    const r = normaliseParts({
      total: 100,
      collectionParts: [
        { accountId: A, amount: 0 },
        { accountId: B, amount: 40 },
        { accountId: C, amount: 0.001 }, // rounds to 0 piasters
      ],
    });
    expect(r.parts.map((p) => [p.partNo, p.accountId, p.amountPt])).toEqual([[1, B, 4000]]);
    expect(r.cashRemainderPt).toBe(6000);
  });

  it("total 0 (fully discounted) → no parts", () => {
    expect(normaliseParts({ total: 0, collectionAccountId: A }).parts).toEqual([]);
    expect(normaliseParts({ total: -5, collectionParts: [{ accountId: A, amount: 5 }] }).parts).toEqual([]);
  });

  it("piaster rounding: 0.1 + 0.2 splits sum exactly to a 0.30 total", () => {
    const r = normaliseParts({
      total: 0.1 + 0.2,
      collectionParts: [
        { accountId: A, amount: 0.1 },
        { accountId: B, amount: 0.2 },
      ],
    });
    expect(r.totalPt).toBe(30);
    expect(r.clamped).toBe(false);
    expect(r.parts.map((p) => p.amountPt)).toEqual([10, 20]);
    expect(r.cashRemainderPt).toBe(0);
  });

  it("blank payer hints become null", () => {
    const r = normaliseParts({ total: 5, payerPhoneLast4: "  ", payerReference: "" });
    expect(r.parts[0]!.payerPhoneLast4).toBeNull();
    expect(r.parts[0]!.payerReference).toBeNull();
  });
});

describe("allocateRejection", () => {
  const line = (saleId: string, saleDate: string, totalPricePt: number, amountPaidPt: number, isReturned = false): RejectionLine => ({
    saleId,
    saleDate,
    totalPricePt,
    amountPaidPt,
    isReturned,
  });

  it("takes from the last line first", () => {
    const r = allocateRejection(
      [
        line("s1", "2026-09-30T10:00:00Z", 5000, 5000),
        line("s2", "2026-09-30T10:00:00Z", 3000, 3000),
        line("s3", "2026-09-30T10:00:00Z", 2000, 2000),
      ],
      4000,
    );
    expect(r.allocations).toEqual([
      { saleId: "s3", takePt: 2000, newAmountPaidPt: 0, totalPricePt: 2000 },
      { saleId: "s2", takePt: 2000, newAmountPaidPt: 1000, totalPricePt: 3000 },
    ]);
    expect(r.unallocatedPt).toBe(0);
  });

  it("orders by sale_date, then id (input order does not matter)", () => {
    const r = allocateRejection(
      [
        line("b", "2026-09-30T10:00:00Z", 1000, 1000),
        line("z", "2026-09-30T09:00:00Z", 1000, 1000),
        line("a", "2026-09-30T10:00:00Z", 1000, 1000),
      ],
      1500,
    );
    // invoice order: z (09:00), a, b → backwards b, a, z
    expect(r.allocations.map((a) => [a.saleId, a.takePt])).toEqual([
      ["b", 1000],
      ["a", 500],
    ]);
  });

  it("non-returned lines are taken before returned ones", () => {
    const r = allocateRejection(
      [
        line("s1", "2026-09-30T10:00:00Z", 1000, 1000),
        line("s2", "2026-09-30T10:01:00Z", 1000, 1000, true),
      ],
      1500,
    );
    expect(r.allocations.map((a) => [a.saleId, a.takePt])).toEqual([
      ["s1", 1000],
      ["s2", 500],
    ]);
  });

  it("Σ takes equals the part amount exactly when the lines hold enough", () => {
    const lines = [
      line("s1", "2026-09-30T10:00:00Z", 3333, 3333),
      line("s2", "2026-09-30T10:00:01Z", 3333, 3333),
      line("s3", "2026-09-30T10:00:02Z", 3334, 3334),
    ];
    const r = allocateRejection(lines, 7777);
    expect(r.allocations.reduce((s, a) => s + a.takePt, 0)).toBe(7777);
    expect(r.unallocatedPt).toBe(0);
  });

  it("records the unallocated remainder when the lines hold less paid money", () => {
    const r = allocateRejection([line("s1", "2026-09-30T10:00:00Z", 5000, 3000)], 5000);
    expect(r.allocations).toEqual([{ saleId: "s1", takePt: 3000, newAmountPaidPt: 0, totalPricePt: 5000 }]);
    expect(r.unallocatedPt).toBe(2000);
  });

  it("skips lines with nothing paid and touches only what it takes from", () => {
    const r = allocateRejection(
      [line("s1", "2026-09-30T10:00:00Z", 1000, 1000), line("s2", "2026-09-30T10:00:01Z", 1000, 0)],
      500,
    );
    expect(r.allocations.map((a) => a.saleId)).toEqual(["s1"]);
    expect(r.allocations[0]!.newAmountPaidPt).toBe(500);
  });
});

describe("deriveInvoiceStatus", () => {
  it.each<[CollectionStatus[], string | null]>([
    [[], null],
    [["void"], null],
    [["pending"], "pending"],
    [["confirmed"], "confirmed"],
    [["auto_confirmed"], "confirmed"],
    [["rejected"], "rejected"],
    [["pending", "rejected"], "pending"],
    [["confirmed", "rejected"], "rejected"],
    [["confirmed", "auto_confirmed"], "confirmed"],
    [["void", "confirmed"], "confirmed"],
    [["void", "pending", "confirmed"], "pending"],
    [["void", "rejected", "auto_confirmed"], "rejected"],
  ])("%j → %s", (statuses, expected) => {
    expect(deriveInvoiceStatus(statuses)).toBe(expected);
  });

  it("covers every CollectionStatus value", () => {
    for (const s of COLLECTION_STATUS_VALUES) {
      const r = deriveInvoiceStatus([s]);
      expect(r === null || ["pending", "confirmed", "rejected"].includes(r)).toBe(true);
    }
  });
});

describe("isStale", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("is strictly older than the threshold", () => {
    expect(isStale({ status: "pending", rungAt: "2026-09-30T10:00:00Z" }, 120, now)).toBe(false); // exactly 120 min
    expect(isStale({ status: "pending", rungAt: "2026-09-30T09:59:59Z" }, 120, now)).toBe(true);
    expect(isStale({ status: "pending", rungAt: new Date("2026-09-30T11:50:00Z") }, 15, now)).toBe(false);
    expect(isStale({ status: "pending", rungAt: new Date("2026-09-30T11:44:00Z") }, 15, now)).toBe(true);
  });

  it("only pending collections are ever stale", () => {
    for (const s of ["confirmed", "auto_confirmed", "rejected", "void"] as const) {
      expect(isStale({ status: s, rungAt: "2026-09-01T00:00:00Z" }, 120, now)).toBe(false);
    }
  });
});

describe("IBAN validation (domain normalizeIban, 03 §B.16)", () => {
  const VALID = "EG380019000500000000263180002";
  it("accepts a valid mod-97 EG IBAN", () => {
    expect(normalizeIban(VALID)).toBe(VALID);
  });
  it("rejects one changed digit", () => {
    expect(normalizeIban("EG380019000500000000263180003")).toBeNull();
  });
  it("rejects a wrong length", () => {
    expect(normalizeIban("EG38001900050000000026318000")).toBeNull();
    expect(normalizeIban("EG3800190005000000002631800021")).toBeNull();
  });
  it("normalises lower-case `eg` and spaces", () => {
    expect(normalizeIban("eg38 0019 0005 0000 0000 2631 8000 2")).toBe(VALID);
  });
});
