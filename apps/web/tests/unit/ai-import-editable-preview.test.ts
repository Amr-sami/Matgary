/**
 * F11 — Editable import preview builder.
 *
 * Covers the pure block-building path: every row in the uploaded file must
 * appear in the preview (no "first 3 samples only" truncation), counts are
 * accurate, update rows carry their existing values, and the ready-to-confirm
 * gate flips correctly when rows have outstanding issues.
 */
import { describe, expect, it } from "vitest";

import { buildEditableImportPreviewBlock } from "@/lib/ai/import/editable-preview";
import type { ProcessedRow } from "@/lib/ai/import/adapters/types";

function row(
  rowIndex: number,
  overrides: Partial<ProcessedRow> & { id?: string } = {},
): ProcessedRow & { id: string } {
  return {
    id: overrides.id ?? `row-${rowIndex}`,
    rowIndex,
    status: overrides.status ?? "ready",
    action: overrides.action ?? "create",
    raw: overrides.raw ?? {},
    normalised:
      overrides.normalised ?? {
        name: `Product ${rowIndex}`,
        sku: `SKU-${rowIndex}`,
        price: 100,
        quantity: 10,
      },
    resolution: overrides.resolution ?? {},
    errors: overrides.errors ?? [],
    issues: overrides.issues ?? [],
  };
}

describe("buildEditableImportPreviewBlock", () => {
  it("surfaces EVERY row — no sample truncation for 13 rows", () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(i + 1));
    const block = buildEditableImportPreviewBlock({
      session: {
        id: "sess-1",
        entityType: "product",
        fileName: "Storo_AI_Product_Import_Test.xlsx",
      },
      rows,
      locale: "en",
    });
    expect(block.kind).toBe("editable_import_preview");
    expect(block.totalRows).toBe(13);
    expect(block.rows).toHaveLength(13);
    expect(block.rows.map((r) => r.rowIndex)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 1),
    );
  });

  it("counts create/update/skip/invalid/missing/ambiguous correctly", () => {
    const rows = [
      row(1, { action: "create", status: "ready" }),
      row(2, { action: "create", status: "ready" }),
      row(3, {
        action: "update",
        status: "ready",
        resolution: { existingValues: { price: 80, quantity: 5 } },
      }),
      row(4, { action: "skip", status: "skipped" }),
      row(5, {
        action: "none",
        status: "invalid",
        errors: [{ field: "price", code: "NEGATIVE_PRICE", message: "Price can't be negative" }],
      }),
      row(6, {
        action: "none",
        status: "missing",
        issues: [{ kind: "missing_field", field: "name", message: "Name is required" }],
      }),
      row(7, {
        action: "none",
        status: "ambiguous",
        issues: [{ kind: "ambiguous_brand", field: "brand", message: "Multiple brand matches" }],
      }),
    ];
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows,
      locale: "en",
    });
    expect(block.toCreate).toBe(2);
    expect(block.toUpdate).toBe(1);
    expect(block.toSkip).toBe(1);
    expect(block.invalid).toBe(1);
    expect(block.missing).toBe(1);
    expect(block.ambiguous).toBe(1);
    expect(block.errorCount).toBe(1); // one row has an error in `errors`
    expect(block.warningCount).toBe(2); // two rows have issues in `issues`
  });

  it("includes existing values for update rows", () => {
    const rows = [
      row(1, {
        action: "update",
        status: "ready",
        normalised: { name: "Blue Diva", sku: "BD-01", price: 1500, quantity: 10 },
        resolution: {
          existingValues: { name: "Blue Diva", sku: "BD-01", price: 1400, quantity: 8 },
        },
      }),
    ];
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows,
      locale: "en",
    });
    expect(block.rows[0]!.existing).toMatchObject({
      price: 1400,
      quantity: 8,
    });
    expect(block.rows[0]!.cells.price).toBe(1500);
  });

  it("never drops a row: 500-row import (editable limit) renders fully", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      row(i + 1, { action: i % 2 === 0 ? "create" : "update" }),
    );
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "big.csv" },
      rows,
      locale: "en",
    });
    expect(block.rows).toHaveLength(500);
    expect(block.toCreate).toBe(250);
    expect(block.toUpdate).toBe(250);
  });

  it("flips readyToConfirm=false when any row has an issue", () => {
    const rows = [
      row(1, { action: "create", status: "ready" }),
      row(2, {
        action: "none",
        status: "invalid",
        errors: [{ field: "name", code: "EMPTY", message: "Name is required" }],
      }),
    ];
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows,
      locale: "en",
    });
    expect(block.readyToConfirm).toBe(false);
  });

  it("readyToConfirm=true when all rows ready + no issues", () => {
    const rows = [
      row(1, { action: "create" }),
      row(2, { action: "update" }),
      row(3, { action: "create" }),
    ];
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows,
      locale: "en",
    });
    expect(block.readyToConfirm).toBe(true);
  });

  it("exposes server row ids so client can PATCH the exact row", () => {
    const rows = [
      row(1, { id: "uuid-aaa" }),
      row(2, { id: "uuid-bbb" }),
    ];
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows,
      locale: "en",
    });
    expect(block.rows[0]!.rowId).toBe("uuid-aaa");
    expect(block.rows[1]!.rowId).toBe("uuid-bbb");
  });

  it("includes full product column set (name, sku, brand, …)", () => {
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows: [row(1)],
      locale: "en",
    });
    const keys = block.columns.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "name",
        "sku",
        "brand",
        "category",
        "price",
        "costPrice",
        "wholesalePrice",
        "quantity",
        "lowStockThreshold",
        "barcode",
        "description",
      ]),
    );
  });

  it("returns Arabic labels when locale=ar", () => {
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows: [row(1)],
      locale: "ar",
    });
    const nameCol = block.columns.find((c) => c.key === "name");
    expect(nameCol?.label).toBe("الاسم");
    const priceCol = block.columns.find((c) => c.key === "price");
    expect(priceCol?.label).toBe("السعر");
  });

  it("surfaces first error/issue as row.issue, full list in row.errors", () => {
    const r = row(5, {
      action: "none",
      status: "invalid",
      errors: [
        { field: "price", code: "NEG", message: "Price can't be negative" },
        { field: "qty", code: "NEG", message: "Quantity can't be negative" },
      ],
      issues: [{ kind: "warn", field: "sku", message: "SKU looks similar to another" }],
    });
    const block = buildEditableImportPreviewBlock({
      session: { id: "s", entityType: "product", fileName: "f.csv" },
      rows: [r],
      locale: "en",
    });
    expect(block.rows[0]!.issue).toBe("Price can't be negative");
    expect(block.rows[0]!.errors).toHaveLength(3);
  });
});
