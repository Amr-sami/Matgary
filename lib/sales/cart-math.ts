// Pure cart math. Lifted from SaleForm.tsx so the totals + loyalty
// clamping logic is unit-testable, free of React, and can be reused
// by a future receipt-preview / printout path.
//
// Mirrors the server-side cap-and-trim logic in `recordCartSale`
// (lib/repo/operations.ts): the cashier sees exactly the same final
// number the server will book.

import type { DiscountType } from "@/lib/types";

export interface CartLineLike {
  quantity: number;
  pricePerUnit: number;
  lineDiscountType: DiscountType;
  lineDiscountValue: number;
}

/** Per-line discount in EGP. Caps at the line subtotal so a percent
 *  > 100 or a fixed amount > subtotal can't go negative. */
export function calcLineDiscount(
  qty: number,
  price: number,
  type: DiscountType,
  value: number,
): number {
  const subtotal = qty * price;
  if (value <= 0) return 0;
  const raw =
    type === "percentage" ? Math.round((subtotal * value) / 100) : value;
  return Math.min(raw, subtotal);
}

export interface CartTotals {
  /** sum of qty × price, before any discount */
  subtotalGross: number;
  /** sum of per-line discounts */
  lineDiscountTotal: number;
  /** subtotalGross − lineDiscountTotal */
  afterLines: number;
  /** order-level discount (already capped to afterLines) */
  orderDiscount: number;
  /** afterLines − orderDiscount */
  afterOrderDiscount: number;
}

export function computeCartTotals(
  lines: CartLineLike[],
  orderDiscount: { type: DiscountType; value: number },
): CartTotals {
  const subtotalGross = lines.reduce(
    (s, l) => s + l.quantity * l.pricePerUnit,
    0,
  );
  const lineDiscountTotal = lines.reduce(
    (s, l) =>
      s +
      calcLineDiscount(
        l.quantity,
        l.pricePerUnit,
        l.lineDiscountType,
        l.lineDiscountValue,
      ),
    0,
  );
  const afterLines = subtotalGross - lineDiscountTotal;
  const orderDiscountAmount =
    orderDiscount.value > 0 && afterLines > 0
      ? Math.min(
          orderDiscount.type === "percentage"
            ? Math.round((afterLines * orderDiscount.value) / 100)
            : orderDiscount.value,
          afterLines,
        )
      : 0;
  return {
    subtotalGross,
    lineDiscountTotal,
    afterLines,
    orderDiscount: orderDiscountAmount,
    afterOrderDiscount: afterLines - orderDiscountAmount,
  };
}

export interface LoyaltyClampInput {
  requestedRedeemPoints: number;
  requestedApplyCredit: number;
  walletPoints: number;
  walletCredit: number;
  egpPerPoint: number;
  cartAfterOrderDiscount: number;
}

export interface LoyaltyClampResult {
  /** Final EGP discount the loyalty redemption produces. */
  loyaltyDiscount: number;
  /** Points actually consumed (≤ requested ≤ wallet). */
  pointsApplied: number;
  /** Credit actually consumed (≤ requested ≤ wallet). */
  creditApplied: number;
  /** True when the cashier's requested redemption was clamped down —
   *  either above wallet balance or above the cart's available
   *  headroom. The UI uses this to surface a "we trimmed your
   *  request" note. */
  wasTrimmed: boolean;
}

/** Caps a redemption request to: a) wallet balance, b) cart headroom
 *  after the order discount. If the request exceeds headroom, credit is
 *  preserved and points are trimmed first (mirrors server-side rule). */
export function clampLoyaltyRedemption(
  input: LoyaltyClampInput,
): LoyaltyClampResult {
  const requestedPoints = Math.max(0, Math.floor(input.requestedRedeemPoints || 0));
  const requestedCredit = Math.max(0, input.requestedApplyCredit || 0);
  const cappedRedeemPoints = Math.min(requestedPoints, input.walletPoints);
  const cappedApplyCredit = Math.min(requestedCredit, input.walletCredit);
  const walletTrimmed =
    requestedPoints > cappedRedeemPoints || requestedCredit > cappedApplyCredit;

  if (cappedRedeemPoints === 0 && cappedApplyCredit === 0) {
    return {
      loyaltyDiscount: 0,
      pointsApplied: 0,
      creditApplied: 0,
      wasTrimmed: walletTrimmed,
    };
  }

  const rate = input.egpPerPoint || 0;
  const pointsValue = Math.round(cappedRedeemPoints * rate * 100) / 100;
  let total = pointsValue + cappedApplyCredit;
  const headroom = input.cartAfterOrderDiscount;

  if (total <= headroom) {
    return {
      loyaltyDiscount: total,
      pointsApplied: cappedRedeemPoints,
      creditApplied: cappedApplyCredit,
      wasTrimmed: walletTrimmed,
    };
  }

  // Trim to headroom: keep credit, cut points first.
  total = headroom;
  if (cappedApplyCredit >= headroom) {
    return {
      loyaltyDiscount: headroom,
      pointsApplied: 0,
      creditApplied: headroom,
      wasTrimmed: true,
    };
  }
  const fromPoints = headroom - cappedApplyCredit;
  const pointsApplied = rate > 0 ? Math.floor(fromPoints / rate) : 0;
  const loyaltyDiscount =
    Math.round(pointsApplied * rate * 100) / 100 + cappedApplyCredit;
  return {
    loyaltyDiscount,
    pointsApplied,
    creditApplied: cappedApplyCredit,
    wasTrimmed: true,
  };
}
