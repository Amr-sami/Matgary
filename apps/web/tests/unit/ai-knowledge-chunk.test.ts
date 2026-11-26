/**
 * F9 — chunker tests. Deterministic; no DB / no Gemini.
 */
import { describe, expect, it } from "vitest";

import { chunkText } from "@/lib/ai/knowledge/chunk";

describe("chunkText", () => {
  it("returns no chunks for empty / whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("captures markdown headings as section metadata", () => {
    const md = `# Return Policy\n\n## Damaged Products\n\nDamaged items can be returned within 30 days of purchase.`;
    const chunks = chunkText(md);
    expect(chunks.length).toBeGreaterThan(0);
    const damaged = chunks.find((c) => c.content.includes("Damaged items"));
    expect(damaged?.section).toBe("Damaged Products");
  });

  it("drops tiny chunks (below MIN) like isolated headings", () => {
    const md = "# Only a heading, nothing else to say.";
    // Short line follows the heading; total is ~40 chars — may or may not
    // emit depending on normalisation. We just assert we don't EXPLODE.
    const chunks = chunkText(md);
    for (const c of chunks) expect(c.content.length).toBeGreaterThanOrEqual(40);
  });

  it("splits long paragraphs under the HARD_CAP", () => {
    const long = "hello world. ".repeat(500); // ~6500 chars
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1500);
  });

  it("preserves Arabic text exactly", () => {
    const ar = "# سياسة الإرجاع\n\nيحق للعميل إرجاع المنتج التالف خلال ٣٠ يومًا من تاريخ الشراء.";
    const chunks = chunkText(ar);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.section).toBe("سياسة الإرجاع");
    expect(chunks[0]!.content).toContain("يحق للعميل");
  });

  it("renumbers chunk indices to be contiguous", () => {
    const md = `# A\n\nFirst section body here.\n\n# B\n\nSecond section body here.\n\n# C\n\nThird section body here.`;
    const chunks = chunkText(md);
    const indices = chunks.map((c) => c.index);
    expect(indices).toEqual([...Array(chunks.length).keys()]);
  });
});
