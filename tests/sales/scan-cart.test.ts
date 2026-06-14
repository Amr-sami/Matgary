import { describe, expect, it } from "vitest";
import { applyScanToCart, resolveScannedSku } from "@/lib/sales/scan-cart";
import type { Product } from "@/lib/types";
import type { CartLine } from "@/lib/sales/scan-cart";

// Minimal Product factory — fills the fields used by the helpers and
// stubs the rest so we don't hard-code shape details that may evolve.
function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    name: "Test product",
    category: "other",
    gender: "unisex",
    quantity: 10,
    price: 100,
    lowStockThreshold: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveScannedSku", () => {
  it("returns the single in-stock match for a unique SKU", () => {
    const products = [
      makeProduct({ id: "a", sku: "1234567890123" }),
      makeProduct({ id: "b", sku: "9999" }),
    ];
    const r = resolveScannedSku(products, "1234567890123");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.product.id).toBe("a");
  });

  it("matches case-insensitively after trimming whitespace", () => {
    const products = [makeProduct({ id: "a", sku: "AbC-001" })];
    const r = resolveScannedSku(products, "  abc-001  ");
    expect(r.kind).toBe("found");
  });

  it("ignores out-of-stock products", () => {
    const products = [
      makeProduct({ id: "a", sku: "X", quantity: 0 }),
      makeProduct({ id: "b", sku: "X", quantity: 5 }),
    ];
    const r = resolveScannedSku(products, "X");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.product.id).toBe("b");
  });

  it("returns not-found when no SKU matches", () => {
    const products = [makeProduct({ id: "a", sku: "1111" })];
    const r = resolveScannedSku(products, "9999");
    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") expect(r.code).toBe("9999");
  });

  it("treats blank input as not-found with empty code", () => {
    const r = resolveScannedSku([makeProduct()], "   ");
    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") expect(r.code).toBe("");
  });

  it("returns 'multiple' when two in-stock products share a SKU", () => {
    const products = [
      makeProduct({ id: "a", sku: "DUP" }),
      makeProduct({ id: "b", sku: "DUP" }),
    ];
    const r = resolveScannedSku(products, "DUP");
    expect(r.kind).toBe("multiple");
    if (r.kind === "multiple") expect(r.matches.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("returns not-found for products whose sku is null/undefined", () => {
    const products = [makeProduct({ id: "a", sku: undefined })];
    const r = resolveScannedSku(products, "anything");
    expect(r.kind).toBe("not-found");
  });
});

describe("applyScanToCart", () => {
  const p1 = makeProduct({ id: "p1", quantity: 5, price: 100 });
  const p2 = makeProduct({ id: "p2", quantity: 2, price: 50 });

  it("appends a new line with qty 1 when product is not in cart", () => {
    const cart: CartLine[] = [];
    const next = applyScanToCart(cart, p1);
    expect(next).toHaveLength(1);
    expect(next[0]!.product.id).toBe("p1");
    expect(next[0]!.quantity).toBe(1);
    expect(next[0]!.pricePerUnit).toBe(100);
    expect(next[0]!.lineDiscountType).toBe("percentage");
    expect(next[0]!.lineDiscountValue).toBe(0);
  });

  it("increments the existing line on a second scan", () => {
    const cart: CartLine[] = [
      { product: p1, quantity: 1, pricePerUnit: 100, lineDiscountType: "percentage", lineDiscountValue: 0 },
    ];
    const next = applyScanToCart(cart, p1);
    expect(next).toHaveLength(1);
    expect(next[0]!.quantity).toBe(2);
  });

  it("does not create a duplicate cart line when the same product is scanned twice", () => {
    let cart: CartLine[] = [];
    cart = applyScanToCart(cart, p1);
    cart = applyScanToCart(cart, p1);
    cart = applyScanToCart(cart, p1);
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(3);
  });

  it("caps quantity at the product's stock", () => {
    let cart: CartLine[] = [];
    for (let i = 0; i < 10; i++) cart = applyScanToCart(cart, p2); // stock = 2
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(2);
  });

  it("refuses to add when stock is zero", () => {
    const oos = makeProduct({ id: "oos", quantity: 0 });
    const next = applyScanToCart([], oos);
    expect(next).toEqual([]);
  });

  it("preserves unrelated cart lines", () => {
    const cart: CartLine[] = [
      { product: p2, quantity: 1, pricePerUnit: 50, lineDiscountType: "percentage", lineDiscountValue: 0 },
    ];
    const next = applyScanToCart(cart, p1);
    expect(next).toHaveLength(2);
    expect(next[0]!.product.id).toBe("p2");
    expect(next[1]!.product.id).toBe("p1");
  });

  it("respects stock reserved by a different cart line of the same product", () => {
    // A manual add already placed qty=2 of p2 (which has stock=2). The
    // scan path should be a no-op (no new line, no qty bump elsewhere).
    const cart: CartLine[] = [
      { product: p2, quantity: 2, pricePerUnit: 50, lineDiscountType: "percentage", lineDiscountValue: 0 },
    ];
    const next = applyScanToCart(cart, p2);
    expect(next).toBe(cart);
  });
});
