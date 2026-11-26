/**
 * F10.1 — Product adapter field-mapping + classification tests.
 *
 * Covers the deterministic parts of the adapter:
 *   • `classify` picks the right confidence tier from sheet headers.
 *   • `mapRow` normalises raw string cells to typed canonical fields.
 *   • Multilingual column aliases (AR/EN/PT/FR/ES) resolve correctly.
 *
 * DB-touching paths (validateAndResolve / executeRow) are covered by the
 * live smoke suite.
 */
import { describe, expect, it } from "vitest";

import { productImportAdapter } from "@/lib/ai/import/adapters/products";
import type { ParsedSheet } from "@/lib/ai/import/parse";

function sheet(columns: string[], rows: Array<Record<string, string>> = []): ParsedSheet {
  return {
    fileName: "test.csv",
    format: "csv",
    columns,
    rows,
    blankRowCount: 0,
  };
}

/* ───────────────────────── classify ────────────────────────────────── */

describe("productImportAdapter.classify", () => {
  it("HIGH confidence on SKU + Name", async () => {
    const r = await productImportAdapter.classify(
      sheet(["SKU", "Name", "Brand", "Sale Price", "Quantity"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r.fieldMappingHint.sku).toBe("SKU");
    expect(r.fieldMappingHint.price).toBe("Sale Price");
    expect(r.fieldMappingHint.quantity).toBe("Quantity");
  });

  it("MEDIUM confidence on Name + Price without SKU", async () => {
    const r = await productImportAdapter.classify(sheet(["Name", "Price"]));
    expect(r.entityType).toBe("product");
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.confidence).toBeLessThan(0.95);
  });

  it("recognises Arabic headers", async () => {
    const r = await productImportAdapter.classify(
      sheet(["كود المنتج", "الاسم", "السعر", "الكمية"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.fieldMappingHint.sku).toBe("كود المنتج");
    expect(r.fieldMappingHint.name).toBe("الاسم");
    expect(r.fieldMappingHint.price).toBe("السعر");
    expect(r.fieldMappingHint.quantity).toBe("الكمية");
  });

  it("recognises Portuguese headers", async () => {
    const r = await productImportAdapter.classify(
      sheet(["Código do produto", "Nome", "Preço", "Quantidade"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.fieldMappingHint.sku).toBe("Código do produto");
    expect(r.fieldMappingHint.price).toBe("Preço");
  });

  it("recognises French headers", async () => {
    const r = await productImportAdapter.classify(
      sheet(["Référence", "Nom", "Prix", "Quantité"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.fieldMappingHint.sku).toBe("Référence");
    expect(r.fieldMappingHint.name).toBe("Nom");
  });

  it("recognises Spanish headers", async () => {
    const r = await productImportAdapter.classify(
      sheet(["Código", "Nombre", "Precio", "Cantidad"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.fieldMappingHint.sku).toBe("Código");
  });

  it("recognises reordered columns (same inputs, different order)", async () => {
    const r = await productImportAdapter.classify(
      sheet(["Quantity", "Brand", "Sale Price", "SKU", "Name"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r.fieldMappingHint.sku).toBe("SKU");
    expect(r.fieldMappingHint.quantity).toBe("Quantity");
  });

  it("recognises mixed AR/EN headers", async () => {
    const r = await productImportAdapter.classify(
      sheet(["SKU", "الاسم", "البراند", "Sale Price", "الكمية"]),
    );
    expect(r.entityType).toBe("product");
    expect(r.fieldMappingHint.sku).toBe("SKU");
    expect(r.fieldMappingHint.name).toBe("الاسم");
    expect(r.fieldMappingHint.brand).toBe("البراند");
    expect(r.fieldMappingHint.price).toBe("Sale Price");
  });

  it("does NOT classify a random sheet as product", async () => {
    const r = await productImportAdapter.classify(
      sheet(["foo", "bar", "baz", "qux"]),
    );
    expect(r.entityType).toBeNull();
  });
});

/* ───────────────────────── mapRow ─────────────────────────────────── */

describe("productImportAdapter.mapRow", () => {
  const mapping = {
    sku: "SKU",
    name: "Name",
    price: "Sale Price",
    quantity: "Quantity",
    wholesalePrice: "Wholesale Price",
  };

  it("maps string → typed fields", () => {
    const r = productImportAdapter.mapRow(
      { SKU: "T17652", Name: "Shirt", "Sale Price": "3000", Quantity: "5" },
      mapping,
    );
    expect(r.sku).toBe("T17652");
    expect(r.name).toBe("Shirt");
    expect(r.price).toBe(3000);
    expect(r.quantity).toBe(5);
  });

  it("strips thousand-separators from numeric cells", () => {
    const r = productImportAdapter.mapRow(
      { SKU: "T1", Name: "A", "Sale Price": "3,000.50", Quantity: "1,200" },
      mapping,
    );
    expect(r.price).toBe(3000.5);
    expect(r.quantity).toBe(1200);
  });

  it("returns null for missing / empty numeric cells", () => {
    const r = productImportAdapter.mapRow(
      { SKU: "T1", Name: "A", "Sale Price": "", Quantity: "   " },
      mapping,
    );
    expect(r.price).toBeNull();
    expect(r.quantity).toBeNull();
  });

  it("returns null for unparseable numerics (not 0, not NaN)", () => {
    const r = productImportAdapter.mapRow(
      { SKU: "T1", Name: "A", "Sale Price": "not-a-number", Quantity: "???" },
      mapping,
    );
    expect(r.price).toBeNull();
    expect(r.quantity).toBeNull();
  });

  it("handles wholesalePrice column separately from sale price", () => {
    const r = productImportAdapter.mapRow(
      { SKU: "T1", Name: "A", "Sale Price": "3000", "Wholesale Price": "2000", Quantity: "5" },
      mapping,
    );
    expect(r.price).toBe(3000);
    expect(r.wholesalePrice).toBe(2000);
  });
});

/* ───────────────────────── canonical schema ─────────────────────── */

describe("productImportAdapter metadata", () => {
  it("exposes the canonical field list", () => {
    expect(productImportAdapter.entityType).toBe("product");
    expect(productImportAdapter.canonicalFields).toContain("sku");
    expect(productImportAdapter.canonicalFields).toContain("price");
    expect(productImportAdapter.canonicalFields).toContain("wholesalePrice");
  });

  it("required fields include name/price/quantity", () => {
    expect(productImportAdapter.requiredForCreate).toEqual(
      expect.arrayContaining(["name", "price", "quantity"]),
    );
  });
});
