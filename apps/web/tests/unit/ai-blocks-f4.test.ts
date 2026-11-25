/**
 * F4 — structured UI block tests.
 *
 * Covers:
 *   • schema + handler validation for the 5 new render_* tools
 *   • grounding guard extensions for clarification + comparison
 *   • deterministic server-side builder correctness (shape only — numeric
 *     values are exercised against live data in scripts/smoke-ai-f4.ts).
 */
import { describe, expect, it } from "vitest";

import { emptyIndex, enforceGrounding } from "@/lib/ai/grounding";
import type {
  AiBlock,
  ClarificationBlock,
  ComparisonBlock,
} from "@/lib/ai/responses";
import type { ToolContext } from "@/lib/ai/context";
import {
  renderClarification,
  renderComparison,
  renderInventorySummary,
  renderSalesSummary,
  renderWarning,
} from "@/lib/ai/tools/render";
import { buildProductComparison } from "@/lib/ai/blocks/summaries";

const CTX: ToolContext = {
  tenantId: "t-1",
  userId: "u-1",
  role: "owner",
  permissions: [],
  locale: "en",
};

/* ────────────────────── render_clarification ─────────────────────────── */

describe("render_clarification handler", () => {
  it("builds a block when ≥2 valid options are given", async () => {
    const r = await renderClarification.handler(CTX, {
      title: "Which product?",
      entity_type: "product",
      options: [
        { entity_id: "aaa", label: "Musk Rumman", follow_up_text: "pick A" },
        { entity_id: "bbb", label: "Pink Diva", follow_up_text: "pick B" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && "blocks" in r) {
      const b = r.blocks[0] as ClarificationBlock;
      expect(b.kind).toBe("clarification");
      expect(b.options).toHaveLength(2);
      expect(b.entityType).toBe("product");
    }
  });

  it("rejects when fewer than 2 options survive validation", async () => {
    const r = await renderClarification.handler(CTX, {
      title: "pick",
      entity_type: "product",
      options: [
        { entity_id: "aaa", label: "", follow_up_text: "x" }, // empty label → dropped
        { entity_id: "bbb", label: "Pink Diva", follow_up_text: "pick B" },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("drops options missing any required field", async () => {
    const r = await renderClarification.handler(CTX, {
      title: "pick",
      entity_type: "product",
      options: [
        { entity_id: "aaa", label: "A", follow_up_text: "fa" },
        { entity_id: "bbb", label: "B", follow_up_text: "fb" },
        { entity_id: "", label: "C", follow_up_text: "fc" }, // no id → dropped
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && "blocks" in r) {
      const b = r.blocks[0] as ClarificationBlock;
      expect(b.options).toHaveLength(2);
    }
  });

  it("falls back to 'product' for an unknown entity_type", async () => {
    const r = await renderClarification.handler(CTX, {
      title: "pick",
      entity_type: "nonsense",
      options: [
        { entity_id: "a", label: "A", follow_up_text: "x" },
        { entity_id: "b", label: "B", follow_up_text: "y" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && "blocks" in r) {
      const b = r.blocks[0] as ClarificationBlock;
      expect(b.entityType).toBe("product");
    }
  });
});

/* ────────────────────── render_warning ────────────────────────────────── */

describe("render_warning handler", () => {
  it("builds a warning with normalised code", async () => {
    const r = await renderWarning.handler(CTX, {
      severity: "warning",
      title: "Sales tax is not tracked",
      message: "Revenue excludes VAT since no tax field is configured.",
      code: "metric-unavailable",
    });
    expect(r.ok).toBe(true);
    if (r.ok && "blocks" in r) {
      const b = r.blocks[0] as AiBlock;
      if (b.kind === "warning") {
        expect(b.code).toBe("METRIC_UNAVAILABLE");
        expect(b.severity).toBe("warning");
      }
    }
  });

  it("rejects an empty message", async () => {
    const r = await renderWarning.handler(CTX, {
      severity: "info",
      title: "x",
      message: "",
      code: "X",
    });
    expect(r.ok).toBe(false);
  });

  it("clamps an unknown severity to warning", async () => {
    const r = await renderWarning.handler(CTX, {
      severity: "panic",
      title: "x",
      message: "m",
      code: "X_Y",
    });
    expect(r.ok).toBe(true);
    if (r.ok && "blocks" in r) {
      const b = r.blocks[0] as AiBlock;
      if (b.kind === "warning") expect(b.severity).toBe("warning");
    }
  });
});

/* ────────────────────── buildProductComparison ───────────────────────── */

describe("buildProductComparison (builder)", () => {
  const sample = (over: Partial<Parameters<typeof buildProductComparison>[0][number]> = {}) => ({
    id: "a",
    name: "A",
    brand: "X",
    sku: "SKU-A",
    price: 100,
    quantity: 10,
    lowStockThreshold: 3,
    ...over,
  });

  it("returns a warning when fewer than 2 products", () => {
    const b = buildProductComparison([sample()], "en") as AiBlock;
    expect(b.kind).toBe("warning");
    if (b.kind === "warning") expect(b.code).toBe("COMPARISON_TOO_FEW");
  });

  it("deduplicates identical ids and refuses to compare a product to itself", () => {
    const b = buildProductComparison(
      [sample({ id: "a" }), sample({ id: "a" })],
      "en",
    ) as AiBlock;
    expect(b.kind).toBe("warning");
    if (b.kind === "warning") expect(b.code).toBe("COMPARISON_DUPLICATE");
  });

  it("names the cheapest as price winner and the most-stocked as stock winner", () => {
    const b = buildProductComparison(
      [
        sample({ id: "a", price: 100, quantity: 5 }),
        sample({ id: "b", price: 50, quantity: 20 }),
        sample({ id: "c", price: 75, quantity: 1 }),
      ],
      "en",
    ) as ComparisonBlock;
    expect(b.kind).toBe("comparison");
    const priceWinner = b.attributes.find((a) => a.label === "Price")?.winnerEntityId;
    const stockWinner = b.attributes.find((a) => a.label === "Stock")?.winnerEntityId;
    expect(priceWinner).toBe("b");
    expect(stockWinner).toBe("b");
  });

  it("caps at 4 entities even when more are passed", () => {
    const b = buildProductComparison(
      ["a", "b", "c", "d", "e"].map((id) => sample({ id })),
      "en",
    ) as ComparisonBlock;
    expect(b.kind).toBe("comparison");
    expect(b.entities).toHaveLength(4);
  });
});

/* ────────────────────── grounding extensions ──────────────────────────── */

describe("enforceGrounding — clarification + comparison", () => {
  it("drops clarification options whose entity isn't in the tool index", () => {
    const idx = emptyIndex();
    idx.productIds.add("real-1");
    idx.productIds.add("real-2");
    const cl: ClarificationBlock = {
      kind: "clarification",
      title: "pick",
      entityType: "product",
      options: [
        { entityId: "real-1", label: "A", followUpText: "x" },
        { entityId: "fake-999", label: "B", followUpText: "y" },
        { entityId: "real-2", label: "C", followUpText: "z" },
      ],
    };
    const { blocks, report } = enforceGrounding([cl], idx);
    expect(blocks).toHaveLength(1);
    const kept = blocks[0] as ClarificationBlock;
    expect(kept.options.map((o) => o.entityId)).toEqual(["real-1", "real-2"]);
    expect(report.droppedClarificationOptions).toEqual([
      { entityId: "fake-999", label: "B" },
    ]);
  });

  it("drops the whole clarification if fewer than 2 options survive", () => {
    const idx = emptyIndex();
    idx.productIds.add("real-1");
    const cl: ClarificationBlock = {
      kind: "clarification",
      title: "pick",
      entityType: "product",
      options: [
        { entityId: "real-1", label: "A", followUpText: "x" },
        { entityId: "fake-999", label: "B", followUpText: "y" },
      ],
    };
    const { blocks, report } = enforceGrounding([cl], idx);
    expect(blocks).toHaveLength(0);
    expect(report.droppedClarifications).toHaveLength(1);
  });

  it("trims comparison entities + values when some ids aren't grounded", () => {
    const idx = emptyIndex();
    idx.productIds.add("a");
    idx.productIds.add("b");
    const cmp: ComparisonBlock = {
      kind: "comparison",
      title: "cmp",
      entityType: "product",
      entities: [
        { entityId: "a", label: "A" },
        { entityId: "b", label: "B" },
        { entityId: "ghost", label: "Ghost" },
      ],
      attributes: [
        { label: "Price", format: "money", winnerEntityId: "ghost" }, // winner is fake
      ],
      values: {
        Price: { a: 100, b: 50, ghost: 999 },
      },
      currency: "EGP",
    };
    const { blocks, report } = enforceGrounding([cmp], idx);
    expect(blocks).toHaveLength(1);
    const kept = blocks[0] as ComparisonBlock;
    expect(kept.entities.map((e) => e.entityId)).toEqual(["a", "b"]);
    expect(kept.values.Price).toEqual({ a: 100, b: 50 });
    expect(kept.attributes[0]!.winnerEntityId).toBeNull();
    expect(report.droppedComparisonEntities).toEqual([
      { entityId: "ghost", label: "Ghost" },
    ]);
  });

  it("drops the whole comparison when it collapses below 2 entities", () => {
    const idx = emptyIndex();
    idx.productIds.add("a");
    const cmp: ComparisonBlock = {
      kind: "comparison",
      title: "cmp",
      entityType: "product",
      entities: [
        { entityId: "a", label: "A" },
        { entityId: "ghost", label: "Ghost" },
      ],
      attributes: [{ label: "Price" }],
      values: { Price: { a: 100, ghost: 999 } },
    };
    const { blocks, report } = enforceGrounding([cmp], idx);
    expect(blocks).toHaveLength(0);
    expect(report.droppedComparisons).toHaveLength(1);
  });
});

/* ────────────────────── tool-registry metadata ────────────────────────── */

describe("new render_* tools are valid Tool objects", () => {
  const tools = [
    renderClarification,
    renderComparison,
    renderInventorySummary,
    renderSalesSummary,
    renderWarning,
  ];
  it.each(tools.map((t) => [t.name, t]))("%s has a strict object schema", (_name, tool) => {
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(typeof tool.handler).toBe("function");
    expect(tool.name.startsWith("render_")).toBe(true);
  });
});
