/**
 * ONE-TURN INVARIANT — block collapse unit tests.
 *
 * The chat pipeline returns one AgentResponse per user turn; the user,
 * however, perceives multiple text blocks within that response as multiple
 * assistant messages because each render_text call produces a paragraph
 * that looks like a standalone bubble. `collapseTurn` is the server-side
 * guarantee that one logical turn → at most one text block.
 *
 * These tests lock down:
 *   • N text blocks collapse into ONE (joined, whitespace-normalised)
 *   • Structured blocks (product_card, kpi, table, chart, confirmation,
 *     editable_import_preview, …) are kept and preserve their order
 *   • Duplicate sentences inside consecutive texts are deduped so the model
 *     restating itself doesn't echo
 *   • Empty/whitespace-only text blocks drop out
 *   • Single-block or already-collapsed inputs are unchanged
 */
import { describe, expect, it } from "vitest";

import { collapseTurn } from "@/lib/ai/blocks/collapse";
import type { AiBlock } from "@/lib/ai/responses";

function text(body: string): AiBlock {
  return { kind: "text", text: body } as AiBlock;
}

function card(id: string, name: string = "Diamond Sakura"): AiBlock {
  return {
    kind: "product_card",
    productId: id,
    name,
    brand: "Ibraq",
    sku: null,
    price: 2200,
    currency: "EGP",
    quantity: 5,
    stockState: "in_stock",
  } as AiBlock;
}

describe("collapseTurn — the one-turn invariant", () => {
  it("empty input → empty output", () => {
    expect(collapseTurn([])).toEqual([]);
  });

  it("single text block → unchanged", () => {
    const blocks = [text("hello")];
    expect(collapseTurn(blocks)).toEqual(blocks);
  });

  it("single structured block → unchanged", () => {
    const blocks = [card("p1")];
    expect(collapseTurn(blocks)).toEqual(blocks);
  });

  it("3 text blocks collapse into 1", () => {
    const out = collapseTurn([
      text("Hi"),
      text("I found the product."),
      text("Let me know if you need more."),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("text");
    expect((out[0] as { text: string }).text).toBe(
      "Hi\n\nI found the product.\n\nLet me know if you need more.",
    );
  });

  it("text + product_card + text → 1 text + 1 card (text first)", () => {
    const out = collapseTurn([text("Here is what I found."), card("p1"), text("Ask if you need more.")]);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("text");
    expect((out[0] as { text: string }).text).toBe(
      "Here is what I found.\n\nAsk if you need more.",
    );
    expect(out[1]!.kind).toBe("product_card");
  });

  it("text ordering: text first, then structured in input order", () => {
    const out = collapseTurn([
      card("p1"),
      text("intro"),
      card("p2"),
      text("outro"),
      card("p3"),
    ]);
    expect(out.map((b) => b.kind)).toEqual([
      "text",
      "product_card",
      "product_card",
      "product_card",
    ]);
    expect((out[1] as { productId: string }).productId).toBe("p1");
    expect((out[2] as { productId: string }).productId).toBe("p2");
    expect((out[3] as { productId: string }).productId).toBe("p3");
    expect((out[0] as { text: string }).text).toBe("intro\n\noutro");
  });

  it("drops empty / whitespace-only text blocks", () => {
    const out = collapseTurn([text(" "), text("hello"), text("\n\n  \n")]);
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text).toBe("hello");
  });

  it("dedupes EXACT consecutive duplicate text (model restating itself verbatim)", () => {
    const out = collapseTurn([
      text("Diamond Sakura is 2200 EGP, 5 in stock."),
      text("Diamond Sakura is 2200 EGP, 5 in stock."), // exact dup
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text).toBe(
      "Diamond Sakura is 2200 EGP, 5 in stock.",
    );
  });

  it("dedupes strict substring text (one message fully contains the other)", () => {
    const out = collapseTurn([
      text("Diamond Sakura is 2200 EGP, 5 in stock."),
      text("Sakura is 2200 EGP"), // strict substring of the previous
    ]);
    expect(out).toHaveLength(1);
    // Keeps the LONGER (more informative) version.
    expect((out[0] as { text: string }).text).toBe(
      "Diamond Sakura is 2200 EGP, 5 in stock.",
    );
  });

  it("supplier-question regression — table + 4 text blocks → table + 1 text", () => {
    // Case B from production: supplier query produced a supplier table
    // followed by ~4 separate text bubbles. Post-fix: one text, table kept.
    const supplierTable: AiBlock = {
      kind: "table",
      title: "Suppliers",
      columns: [{ key: "name", label: "Name" }],
      rows: [{ name: "Supplier A" }, { name: "Supplier B" }],
    } as AiBlock;
    const out = collapseTurn([
      supplierTable,
      text("Here are your suppliers."),
      text("I found a few more details."),
      text("Would you like to see more?"),
      text("Let me know."),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("text");
    expect(out[1]!.kind).toBe("table");
    // All four texts joined, dedup not triggered because they're distinct.
    expect((out[0] as { text: string }).text).toContain("Here are your suppliers.");
    expect((out[0] as { text: string }).text).toContain("Let me know.");
  });

  it("greeting regression — 5 pleasantries → ONE text block", () => {
    // Case A from production: "Hi" produced ~5 assistant bubbles.
    const out = collapseTurn([
      text("Hi!"),
      text("I'm your Storo AI assistant."),
      text("I can help with sales, inventory, products, and more."),
      text("What would you like to know?"),
      text("Just ask."),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("text");
  });

  it("confirmation turn: preview + confirmation stays intact", () => {
    // preview_import emits [preview, confirmation] with a short caption.
    const preview: AiBlock = {
      kind: "import_preview",
      sessionId: "sess-1",
      entityType: "product",
      fileName: "p.xlsx",
      totalRows: 13,
      toCreate: 12,
      toUpdate: 1,
      toSkip: 0,
      invalid: 0,
      ambiguous: 0,
      missing: 0,
      sampleCreate: [],
      sampleUpdate: [],
      sampleIssues: [],
      title: "Preview",
      description: "13 rows",
    } as AiBlock;
    const confirm: AiBlock = {
      kind: "confirmation",
      title: "Preview",
      summary: "13 rows",
      actionLabel: "Confirm",
      token: "abc.def",
      expiresAt: "2026-11-09T18:00:00Z",
    } as AiBlock;
    const out = collapseTurn([text("Ready to confirm?"), preview, confirm]);
    expect(out.map((b) => b.kind)).toEqual([
      "text",
      "import_preview",
      "confirmation",
    ]);
  });

  it("whitespace-normalises inside joined text", () => {
    const out = collapseTurn([text("A  \n  B"), text("  C  \nD  ")]);
    expect((out[0] as { text: string }).text).toBe("A B\n\nC D");
  });
});
