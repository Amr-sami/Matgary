import { describe, expect, it } from "vitest";
import {
  calcCartTotals,
  calcLineDiscount,
  calcOrderDiscount,
} from "@/lib/repo/sale-discounts";

// Production rounding convention: Math.round (half-away-from-zero for
// positive inputs). Receipt + insights both follow this — confirmed by
// reading lib/repo/operations.ts before the extraction. Locking it in
// here means any future change to the rounding rule fails the test
// instead of silently shifting receipt totals.

describe("calcLineDiscount", () => {
  it("returns 0 when no discount is supplied", () => {
    expect(calcLineDiscount(1000)).toBe(0);
    expect(calcLineDiscount(1000, "percentage", 0)).toBe(0);
    expect(calcLineDiscount(1000, "fixed", 0)).toBe(0);
  });

  it("returns 0 when subtotal is 0 (free-item edge case — no divide by anything)", () => {
    expect(calcLineDiscount(0, "percentage", 50)).toBe(0);
    expect(calcLineDiscount(0, "fixed", 100)).toBe(0);
  });

  it("applies percentage discounts rounded to the nearest EGP", () => {
    expect(calcLineDiscount(1000, "percentage", 10)).toBe(100);
    // 333 * 10% = 33.3 → 33 (Math.round rounds-half-away-from-zero only for .5 — .3 rounds down).
    expect(calcLineDiscount(333, "percentage", 10)).toBe(33);
    // 335 * 10% = 33.5 → 34.
    expect(calcLineDiscount(335, "percentage", 10)).toBe(34);
  });

  it("applies absolute discounts unchanged", () => {
    expect(calcLineDiscount(1000, "fixed", 250)).toBe(250);
  });

  it("caps the discount at the subtotal (no negative totals)", () => {
    expect(calcLineDiscount(100, "fixed", 999)).toBe(100);
    expect(calcLineDiscount(100, "percentage", 200)).toBe(100);
  });

  it("treats negative values as zero rather than throwing", () => {
    expect(calcLineDiscount(1000, "fixed", -50)).toBe(0);
    expect(calcLineDiscount(-50, "fixed", 10)).toBe(0);
  });
});

describe("calcOrderDiscount", () => {
  it("mirrors line discount rules but against cartGross", () => {
    expect(calcOrderDiscount(2000, "percentage", 25)).toBe(500);
    expect(calcOrderDiscount(2000, "fixed", 333)).toBe(333);
  });

  it("returns 0 when cart is empty", () => {
    expect(calcOrderDiscount(0, "percentage", 25)).toBe(0);
    expect(calcOrderDiscount(0, "fixed", 1000)).toBe(0);
  });

  it("caps at cartGross", () => {
    expect(calcOrderDiscount(100, "fixed", 999)).toBe(100);
  });
});

describe("calcCartTotals — composition", () => {
  it("sums line nets when no discounts apply", () => {
    const r = calcCartTotals(
      [
        { quantity: 2, pricePerUnit: 50 },
        { quantity: 1, pricePerUnit: 100 },
      ],
      undefined,
    );
    expect(r.lines).toEqual([
      { subtotal: 100, lineDiscount: 0, net: 100 },
      { subtotal: 100, lineDiscount: 0, net: 100 },
    ]);
    expect(r.cartGross).toBe(200);
    expect(r.orderDiscount).toBe(0);
    expect(r.total).toBe(200);
  });

  it("applies line discounts BEFORE summing into cartGross, then order discount on the net cart", () => {
    const r = calcCartTotals(
      [
        // 200 - 20 (10%) = 180
        {
          quantity: 1,
          pricePerUnit: 200,
          lineDiscountType: "percentage",
          lineDiscountValue: 10,
        },
        // 100 - 30 (absolute) = 70
        {
          quantity: 1,
          pricePerUnit: 100,
          lineDiscountType: "fixed",
          lineDiscountValue: 30,
        },
      ],
      // 250 cart - 25 (10% of 250) = 225 final
      { type: "percentage", value: 10 },
    );
    expect(r.cartGross).toBe(250);
    expect(r.orderDiscount).toBe(25);
    expect(r.total).toBe(225);
  });

  it("survives the free-item edge case without producing NaN or negative numbers", () => {
    const r = calcCartTotals(
      [
        { quantity: 0, pricePerUnit: 500 },
        { quantity: 5, pricePerUnit: 0 },
      ],
      { type: "percentage", value: 25 },
    );
    expect(r.cartGross).toBe(0);
    expect(r.orderDiscount).toBe(0);
    expect(r.total).toBe(0);
  });

  it("an over-large order discount cannot create a negative cart total", () => {
    const r = calcCartTotals(
      [{ quantity: 1, pricePerUnit: 100 }],
      { type: "fixed", value: 999 },
    );
    expect(r.total).toBe(0);
  });
});
