/**
 * F3 — grounding guard tests.
 *
 * Verifies that `enforceGrounding` drops ONLY product_card blocks whose
 * productId wasn't surfaced by a tool in the same turn — and leaves every
 * other block untouched.
 */
import { describe, expect, it } from "vitest";

import {
  emptyIndex,
  enforceGrounding,
  indexToolResult,
} from "@/lib/ai/grounding";
import type { AiBlock } from "@/lib/ai/responses";

describe("indexToolResult", () => {
  it("indexes candidate ids from a search_products result", () => {
    const idx = emptyIndex();
    indexToolResult(idx, {
      data: {
        query: "assaf",
        candidates: [
          { id: "aaa-111", name: "Musk Rumman", price: 2200 },
          { id: "bbb-222", name: "Pink Diva", price: 2200 },
        ],
      },
    });
    expect(idx.productIds.has("aaa-111")).toBe(true);
    expect(idx.productIds.has("bbb-222")).toBe(true);
    expect(idx.productIds.size).toBe(2);
  });

  it("indexes a single product from get_product", () => {
    const idx = emptyIndex();
    indexToolResult(idx, {
      data: { product: { id: "ccc-333", name: "Test" } },
    });
    expect(idx.productIds.has("ccc-333")).toBe(true);
  });

  it("is a no-op on malformed or unrelated shapes", () => {
    const idx = emptyIndex();
    indexToolResult(idx, null);
    indexToolResult(idx, "string");
    indexToolResult(idx, { data: { noise: true } });
    indexToolResult(idx, {});
    expect(idx.productIds.size).toBe(0);
  });
});

describe("enforceGrounding", () => {
  const sample = (productId: string): AiBlock => ({
    kind: "product_card",
    productId,
    name: "Whatever",
    brand: null,
    sku: null,
    price: 100,
    currency: "EGP",
    quantity: 1,
    stockState: "in_stock",
  });

  it("passes through product_cards whose id is grounded", () => {
    const idx = emptyIndex();
    idx.productIds.add("real-1");
    const { blocks, report } = enforceGrounding(
      [sample("real-1"), { kind: "text", text: "ok" }],
      idx,
    );
    expect(blocks).toHaveLength(2);
    expect(report.droppedProductCards).toHaveLength(0);
  });

  it("DROPS a product_card whose id is NOT grounded (hallucinated id)", () => {
    const idx = emptyIndex();
    idx.productIds.add("real-1");
    const { blocks, report } = enforceGrounding(
      [sample("fake-999"), { kind: "text", text: "see above" }],
      idx,
    );
    // product_card dropped; text passes through.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("text");
    expect(report.droppedProductCards).toEqual([
      { productId: "fake-999", name: "Whatever" },
    ]);
  });

  it("drops only the invented card when some are valid and some are not", () => {
    const idx = emptyIndex();
    idx.productIds.add("real-1");
    const { blocks, report } = enforceGrounding(
      [sample("real-1"), sample("fake-x"), sample("real-1")],
      idx,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === "product_card" && (b as { productId: string }).productId === "real-1")).toBe(true);
    expect(report.droppedProductCards).toHaveLength(1);
  });

  it("never touches non-product_card blocks", () => {
    const idx = emptyIndex();
    const blocks: AiBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "kpi", items: [{ label: "x", value: "1" }] },
      {
        kind: "chart",
        chartType: "line",
        title: "t",
        series: [{ dataKey: "v", label: "v" }],
        data: [{ x: 1, v: 2 }],
      },
      {
        kind: "table",
        title: "t",
        columns: [{ key: "k", label: "K" }],
        rows: [{ k: "v" }],
      },
    ];
    const out = enforceGrounding(blocks, idx);
    expect(out.blocks).toEqual(blocks);
    expect(out.report.droppedProductCards).toHaveLength(0);
  });
});
