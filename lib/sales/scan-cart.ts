// Pure helpers for the barcode-scan flow. Extracted from the React
// components so they can be unit-tested without jsdom.
//
// `resolveScannedSku` is shared by the POS picker AND (in spirit) the
// inventory edit/add path — anywhere we need to know whether a scanned
// code already lives in the catalog. Multiple matches are returned
// verbatim so the caller can show a picker.
//
// `applyScanToCart` encodes the POS-specific rule: a second scan of the
// same product never creates a duplicate cart line, it bumps the
// existing line's quantity (capped by remaining stock). The manual
// "Add to cart" flow is intentionally NOT routed through here — that
// path still lets the cashier add the same product twice with different
// per-line discounts.

import type { Product, DiscountType } from "@/lib/types";

export type ScanResolution<P extends { sku?: string | null | undefined; quantity: number }> =
  | { kind: "found"; product: P }
  | { kind: "multiple"; matches: P[] }
  | { kind: "not-found"; code: string };

export function resolveScannedSku<
  P extends { sku?: string | null | undefined; quantity: number },
>(products: P[], code: string): ScanResolution<P> {
  const trimmed = code.trim();
  if (!trimmed) return { kind: "not-found", code: "" };
  const lc = trimmed.toLowerCase();
  const matches = products.filter(
    (p) => p.quantity > 0 && (p.sku ?? "").toLowerCase() === lc,
  );
  if (matches.length === 1) return { kind: "found", product: matches[0]! };
  if (matches.length === 0) return { kind: "not-found", code: trimmed };
  return { kind: "multiple", matches };
}

export interface CartLine {
  product: Product;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType: DiscountType;
  lineDiscountValue: number;
}

export function applyScanToCart(cart: CartLine[], product: Product): CartLine[] {
  const idx = cart.findIndex((l) => l.product.id === product.id);
  if (idx >= 0) {
    const line = cart[idx]!;
    const reservedElsewhere = cart
      .filter((l, i) => l.product.id === product.id && i !== idx)
      .reduce((s, l) => s + l.quantity, 0);
    const maxQty = product.quantity - reservedElsewhere;
    const nextQty = Math.min(line.quantity + 1, maxQty);
    if (nextQty === line.quantity) return cart;
    const copy = [...cart];
    copy[idx] = { ...line, quantity: nextQty };
    return copy;
  }
  const reservedForProduct = cart
    .filter((l) => l.product.id === product.id)
    .reduce((s, l) => s + l.quantity, 0);
  if (product.quantity - reservedForProduct < 1) return cart;
  return [
    ...cart,
    {
      product,
      quantity: 1,
      pricePerUnit: product.price,
      lineDiscountType: "percentage",
      lineDiscountValue: 0,
    },
  ];
}
