// Pure helpers for the barcode-scan flow. Extracted from the React
// components so they can be unit-tested without jsdom.
//
// `resolveScannedSku` is shared by the POS picker AND (in spirit) the
// inventory edit/add path — anywhere we need to know whether a scanned
// code already lives in the catalog. Multiple matches are returned
// verbatim so the caller can show a picker; zero-stock matches surface
// as `out-of-stock` so the caller can tell the cashier "this product
// exists, just top up the stock" instead of the misleading "not found".
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
  | { kind: "out-of-stock"; product: P }
  | { kind: "multiple"; matches: P[] }
  | { kind: "not-found"; code: string };

// Whitespace + ASCII control + BOM + zero-width characters. Built via
// `new RegExp` from unicode escape sequences so the source file never
// contains literal invisible chars (those break some editors / merge
// tools and made earlier inline regexes silently truncate).
const SKU_STRIP_RE = new RegExp(
  "[\\s\\u0000-\\u001F\\u007F\\u200B\\u200C\\u200D\\uFEFF]",
  "g",
);

/**
 * Normalize a SKU / barcode so two decoded values that represent the
 * same physical code compare equal. Handles two real-world hazards:
 *
 *  1. Decoders occasionally emit invisible characters (NULs, control
 *     bytes, BOM, zero-width joiners). The write side trims spaces
 *     but leaves these.
 *  2. UPC-A ↔ EAN-13 ambiguity. A UPC-A barcode is 12 digits; iOS /
 *     native BarcodeDetector sometimes returns it as a 13-digit EAN-13
 *     with a leading "0". We collapse that single leading zero so both
 *     encodings match the same record.
 */
export function normalizeSku(raw: string): string {
  const cleaned = raw.replace(SKU_STRIP_RE, "").toLowerCase();
  if (/^0\d{12}$/.test(cleaned)) return cleaned.slice(1);
  return cleaned;
}

export function resolveScannedSku<
  P extends { sku?: string | null | undefined; quantity: number },
>(products: P[], code: string): ScanResolution<P> {
  const trimmed = code.trim();
  if (!trimmed) return { kind: "not-found", code: "" };
  const target = normalizeSku(trimmed);
  if (!target) return { kind: "not-found", code: trimmed };
  // Match WITHOUT the stock filter — stock state is reported back as a
  // distinct resolution so the UI can tell "exists but empty" from
  // "doesn't exist at all". This was the source of the cashier-side
  // "not found" bug when a freshly-added product still had qty 0.
  const matches = products.filter(
    (p) => normalizeSku(p.sku ?? "") === target,
  );
  if (matches.length === 0) return { kind: "not-found", code: trimmed };

  // For multi-match, prefer in-stock entries. If exactly one variant
  // has stock, pick it silently — that's the cashier's intent. If
  // every variant is empty, surface the first as out-of-stock. If
  // multiple in-stock variants share the SKU, fall through to a picker.
  if (matches.length > 1) {
    const inStock = matches.filter((p) => p.quantity > 0);
    if (inStock.length === 1) return { kind: "found", product: inStock[0]! };
    if (inStock.length === 0) return { kind: "out-of-stock", product: matches[0]! };
    return { kind: "multiple", matches: inStock };
  }

  const only = matches[0]!;
  return only.quantity > 0
    ? { kind: "found", product: only }
    : { kind: "out-of-stock", product: only };
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
