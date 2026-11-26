import type { DiscountType } from "@/lib/types";

// Pure discount math, extracted from operations.ts so it can be unit-tested
// without standing up a DB. Convention matches the existing production code:
//
// - All inputs are non-negative integers/decimals in EGP. Negative inputs are
//   treated as zero rather than throwing — sale recording rejects them at the
//   route layer so this stays focused on arithmetic.
// - Percentage discounts use `Math.round` to whole EGP, matching what the
//   receipt + insights aggregations have always used.
// - A discount can never exceed the subtotal it applies to (anti-bug guard).

export function calcLineDiscount(
  subtotal: number,
  type?: DiscountType,
  value?: number,
): number {
  if (!type || !value || value <= 0 || subtotal <= 0) return 0;
  const raw =
    type === "percentage"
      ? Math.round((subtotal * value) / 100)
      : value;
  return Math.min(Math.max(raw, 0), subtotal);
}

export function calcOrderDiscount(
  cartGross: number,
  type?: DiscountType,
  value?: number,
): number {
  if (!type || !value || value <= 0 || cartGross <= 0) return 0;
  const raw =
    type === "percentage"
      ? Math.round((cartGross * value) / 100)
      : value;
  return Math.min(Math.max(raw, 0), cartGross);
}

export interface CartLineCalc {
  subtotal: number;
  lineDiscount: number;
  net: number;
}

/**
 * Roll a list of (quantity, pricePerUnit, optional line discount) tuples up
 * into per-line subtotals + cart net, then apply an optional order-level
 * discount on top. Returns the components the production path uses.
 */
export function calcCartTotals(
  lines: ReadonlyArray<{
    quantity: number;
    pricePerUnit: number;
    lineDiscountType?: DiscountType;
    lineDiscountValue?: number;
  }>,
  order?: { type?: DiscountType; value?: number },
): {
  lines: CartLineCalc[];
  cartGross: number;
  orderDiscount: number;
  total: number;
} {
  const per: CartLineCalc[] = lines.map((l) => {
    const subtotal = Math.max(0, l.quantity) * Math.max(0, l.pricePerUnit);
    const lineDiscount = calcLineDiscount(
      subtotal,
      l.lineDiscountType,
      l.lineDiscountValue,
    );
    return { subtotal, lineDiscount, net: subtotal - lineDiscount };
  });
  const cartGross = per.reduce((acc, l) => acc + l.net, 0);
  const orderDiscount = calcOrderDiscount(cartGross, order?.type, order?.value);
  return {
    lines: per,
    cartGross,
    orderDiscount,
    total: cartGross - orderDiscount,
  };
}
