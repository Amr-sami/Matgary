import { describe, expect, it } from "vitest";
import {
  calcLineDiscount,
  computeCartTotals,
  clampLoyaltyRedemption,
} from "@/lib/sales/cart-math";
import type { CartLineLike } from "@/lib/sales/cart-math";

describe("calcLineDiscount", () => {
  it("returns 0 for zero or negative discount value", () => {
    expect(calcLineDiscount(2, 100, "percentage", 0)).toBe(0);
    expect(calcLineDiscount(2, 100, "fixed", -5)).toBe(0);
  });

  it("computes percentage discount, rounded", () => {
    // 2 × 100 = 200; 15% = 30
    expect(calcLineDiscount(2, 100, "percentage", 15)).toBe(30);
    // rounding: 3 × 33 = 99; 10% = 9.9 → rounds to 10
    expect(calcLineDiscount(3, 33, "percentage", 10)).toBe(10);
  });

  it("computes fixed discount, capped at subtotal", () => {
    // 1 × 100 = 100; fixed 30 → 30
    expect(calcLineDiscount(1, 100, "fixed", 30)).toBe(30);
    // 1 × 100; fixed 200 → capped to 100
    expect(calcLineDiscount(1, 100, "fixed", 200)).toBe(100);
  });

  it("caps percentage > 100 at the line subtotal", () => {
    expect(calcLineDiscount(1, 50, "percentage", 150)).toBe(50);
  });
});

describe("computeCartTotals", () => {
  const line = (
    qty: number,
    price: number,
    dt: "percentage" | "fixed" = "percentage",
    dv = 0,
  ): CartLineLike => ({
    quantity: qty,
    pricePerUnit: price,
    lineDiscountType: dt,
    lineDiscountValue: dv,
  });

  it("returns zeros for empty cart", () => {
    expect(computeCartTotals([], { type: "percentage", value: 0 })).toEqual({
      subtotalGross: 0,
      lineDiscountTotal: 0,
      afterLines: 0,
      orderDiscount: 0,
      afterOrderDiscount: 0,
    });
  });

  it("sums gross subtotal", () => {
    const r = computeCartTotals(
      [line(2, 100), line(1, 50)],
      { type: "percentage", value: 0 },
    );
    expect(r.subtotalGross).toBe(250);
    expect(r.lineDiscountTotal).toBe(0);
    expect(r.afterLines).toBe(250);
  });

  it("subtracts line discounts then applies percentage order discount", () => {
    const r = computeCartTotals(
      [line(2, 100, "percentage", 10), line(1, 50)], // line discount: 20
      { type: "percentage", value: 10 },              // order discount: 10% of 230 = 23
    );
    expect(r.afterLines).toBe(230);
    expect(r.orderDiscount).toBe(23);
    expect(r.afterOrderDiscount).toBe(207);
  });

  it("caps fixed order discount to after-lines", () => {
    const r = computeCartTotals(
      [line(1, 50)],
      { type: "fixed", value: 200 },
    );
    expect(r.orderDiscount).toBe(50);
    expect(r.afterOrderDiscount).toBe(0);
  });

  it("ignores order discount when after-lines is zero", () => {
    const r = computeCartTotals(
      [line(1, 100, "fixed", 100)], // line wipes out the cart
      { type: "percentage", value: 10 },
    );
    expect(r.afterLines).toBe(0);
    expect(r.orderDiscount).toBe(0);
    expect(r.afterOrderDiscount).toBe(0);
  });
});

describe("clampLoyaltyRedemption", () => {
  const base = {
    walletPoints: 1000,
    walletCredit: 100,
    egpPerPoint: 0.5, // 1 point = 0.5 EGP
    cartAfterOrderDiscount: 500,
  };

  it("returns zero when nothing requested", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      requestedRedeemPoints: 0,
      requestedApplyCredit: 0,
    });
    expect(r).toEqual({
      loyaltyDiscount: 0,
      pointsApplied: 0,
      creditApplied: 0,
      wasTrimmed: false,
    });
  });

  it("caps points to wallet balance", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      requestedRedeemPoints: 5000, // wallet only has 1000
      requestedApplyCredit: 0,
    });
    expect(r.pointsApplied).toBe(1000);
    expect(r.loyaltyDiscount).toBe(500); // 1000 × 0.5
  });

  it("caps credit to wallet balance", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      requestedRedeemPoints: 0,
      requestedApplyCredit: 500, // wallet only has 100
    });
    expect(r.creditApplied).toBe(100);
    expect(r.loyaltyDiscount).toBe(100);
  });

  it("applies both within headroom", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      requestedRedeemPoints: 100, // 50 EGP
      requestedApplyCredit: 50,
    });
    expect(r).toEqual({
      loyaltyDiscount: 100,
      pointsApplied: 100,
      creditApplied: 50,
      wasTrimmed: false,
    });
  });

  it("trims points first when total exceeds headroom (preserve credit)", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      cartAfterOrderDiscount: 60, // small cart
      requestedRedeemPoints: 200, // 100 EGP
      requestedApplyCredit: 30,
    });
    expect(r.creditApplied).toBe(30);     // credit preserved
    expect(r.loyaltyDiscount).toBe(60);    // capped at cart
    // points-from-headroom: (60 - 30) / 0.5 = 60 points
    expect(r.pointsApplied).toBe(60);
  });

  it("zeros points when credit alone exceeds headroom", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      cartAfterOrderDiscount: 80,
      requestedRedeemPoints: 100,
      requestedApplyCredit: 100,
    });
    expect(r.pointsApplied).toBe(0);
    expect(r.creditApplied).toBe(80);
    expect(r.loyaltyDiscount).toBe(80);
  });

  it("handles zero egpPerPoint (points are worthless)", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      egpPerPoint: 0,
      requestedRedeemPoints: 100,
      requestedApplyCredit: 0,
    });
    expect(r.loyaltyDiscount).toBe(0);
    expect(r.pointsApplied).toBe(100); // capped at wallet, but worth 0
  });

  it("ignores negative requested values", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      requestedRedeemPoints: -10,
      requestedApplyCredit: -5,
    });
    expect(r).toEqual({
      loyaltyDiscount: 0,
      pointsApplied: 0,
      creditApplied: 0,
      wasTrimmed: false,
    });
  });

  it("sets wasTrimmed when request exceeds wallet", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      requestedRedeemPoints: 5000,
      requestedApplyCredit: 0,
    });
    expect(r.wasTrimmed).toBe(true);
  });

  it("sets wasTrimmed when request exceeds headroom", () => {
    const r = clampLoyaltyRedemption({
      ...base,
      cartAfterOrderDiscount: 50,
      requestedRedeemPoints: 200, // 100 EGP > 50 headroom
      requestedApplyCredit: 0,
    });
    expect(r.wasTrimmed).toBe(true);
  });
});
