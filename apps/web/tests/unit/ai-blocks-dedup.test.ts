/**
 * Root-cause regression — the agent must never emit the same block twice
 * even when the model re-calls render_product_card or render_text across
 * multiple rounds.
 *
 * Pre-fix behaviour (reproducible with the `dedupBlocks` + `mergeDedup`
 * helpers removed): one product question could produce 2–3 identical product
 * cards + descriptions in the final response. Post-fix: identity is by the
 * stable cell per block kind, first occurrence wins.
 */
import { describe, expect, it } from "vitest";

import { dedupBlocks, dedupKey, mergeDedup } from "@/lib/ai/blocks/dedup";
import type { AiBlock } from "@/lib/ai/responses";

function card(productId: string, extra: Partial<AiBlock> = {}): AiBlock {
  return {
    kind: "product_card",
    productId,
    name: "Diamond Sakura",
    brand: "Ibraq",
    sku: "5012345678900",
    price: 2200,
    currency: "EGP",
    quantity: 5,
    stockState: "in_stock",
    ...extra,
  } as AiBlock;
}

function text(body: string): AiBlock {
  return { kind: "text", text: body } as AiBlock;
}

describe("dedupKey", () => {
  it("keys product_card by productId", () => {
    expect(dedupKey(card("p1"))).toBe("product_card:p1");
    // Different brand but same productId → still same key.
    expect(dedupKey(card("p1", { brand: "Other" }))).toBe("product_card:p1");
    expect(dedupKey(card("p2"))).toBe("product_card:p2");
  });

  it("keys text by normalised whitespace", () => {
    expect(dedupKey(text("Diamond Sakura price is 2200."))).toBe(
      dedupKey(text("  Diamond Sakura   price is 2200.  ")),
    );
    expect(dedupKey(text("Diamond Sakura price is 2200."))).not.toBe(
      dedupKey(text("Diamond Sakura price is 2500.")),
    );
  });
});

describe("dedupBlocks", () => {
  it("drops the second product_card for the same productId", () => {
    const blocks = [card("p1"), card("p1"), card("p1")];
    const out = dedupBlocks(blocks);
    expect(out).toHaveLength(1);
    expect((out[0] as { productId: string }).productId).toBe("p1");
  });

  it("drops the second identical text, preserves different text", () => {
    const blocks = [
      text("Diamond Sakura price is 2200 EGP, 5 in stock."),
      text("Diamond Sakura price is 2200 EGP, 5 in stock."),
      text("Other note."),
    ];
    expect(dedupBlocks(blocks)).toHaveLength(2);
  });

  it("keeps different product cards", () => {
    expect(dedupBlocks([card("p1"), card("p2"), card("p3")])).toHaveLength(3);
  });

  it("preserves block order (first wins)", () => {
    const first = card("p1", { name: "First" });
    const second = card("p1", { name: "Second" });
    const out = dedupBlocks([first, second]);
    expect(out).toHaveLength(1);
    expect((out[0] as { name: string }).name).toBe("First");
  });
});

describe("mergeDedup", () => {
  it("skips any next block whose key already exists in existing", () => {
    const existing = [card("p1"), text("hello")];
    const next = [card("p1"), text("hello"), card("p2")];
    const merged = mergeDedup(existing, next);
    // p1 + hello from existing; only p2 added
    expect(merged.map((b) => dedupKey(b))).toEqual([
      "product_card:p1",
      "text:hello",
      "product_card:p2",
    ]);
  });

  it("models the duplicate product-card regression: same tool, two rounds", () => {
    // Round 1 — model calls render_product_card for diamond sakura
    const round1 = [card("sakura"), text("Diamond Sakura price is 2200 EGP, 5 in stock.")];
    // Round 2 — model loops and re-calls the same renders (e.g. salvage nudge)
    const round2 = [card("sakura"), text("Diamond Sakura price is 2200 EGP, 5 in stock.")];
    let rendered: AiBlock[] = [];
    rendered = mergeDedup(rendered, round1);
    rendered = mergeDedup(rendered, round2);
    expect(rendered).toHaveLength(2); // one card + one text, never doubled
    expect(rendered.filter((b) => b.kind === "product_card")).toHaveLength(1);
    expect(rendered.filter((b) => b.kind === "text")).toHaveLength(1);
  });

  it("allows a different product on a subsequent render call", () => {
    const rendered = mergeDedup([card("a")], [card("a"), card("b")]);
    expect(rendered.map((b) => dedupKey(b))).toEqual([
      "product_card:a",
      "product_card:b",
    ]);
  });
});
