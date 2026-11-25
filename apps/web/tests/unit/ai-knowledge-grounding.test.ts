/**
 * F9 — knowledge grounding + citation validation tests.
 *
 * Verifies that `indexToolResult` captures chunk metadata from the
 * search_knowledge tool output, and that `enforceGrounding`:
 *   • rewrites every KnowledgeAnswerBlock citation with server-grounded
 *     title/version/section/tier,
 *   • drops citations whose chunkId wasn't retrieved this turn,
 *   • drops NONE-tier citations,
 *   • drops the whole answer if every citation is dropped.
 */
import { describe, expect, it } from "vitest";

import { emptyIndex, enforceGrounding, indexToolResult } from "@/lib/ai/grounding";
import type { AiBlock, KnowledgeAnswerBlock } from "@/lib/ai/responses";

function makeKnowledgeToolResult(hits: Array<{
  chunkId: string;
  documentId: string;
  documentTitle: string;
  documentVersion: number;
  section?: string | null;
  tier: "HIGH" | "MEDIUM" | "LOW" | "NONE";
}>) {
  return {
    ok: true,
    data: {
      query: "x",
      topScore: 0.9,
      topTier: hits[0]?.tier ?? "NONE",
      retrievedCount: hits.length,
      hits: hits.map((h) => ({
        chunkId: h.chunkId,
        documentId: h.documentId,
        documentTitle: h.documentTitle,
        documentVersion: h.documentVersion,
        documentType: "policy",
        section: h.section ?? null,
        language: "en",
        score: 0.9,
        tier: h.tier,
        content: "<EVIDENCE>...</EVIDENCE>",
      })),
    },
  };
}

function kaBlock(sourceIds: string[]): KnowledgeAnswerBlock {
  return {
    kind: "knowledge_answer",
    answer: "According to policy, X.",
    sources: sourceIds.map((id) => ({
      documentId: "",
      chunkId: id,
      title: "",
      version: 0,
      section: null,
      tier: "LOW" as const,
    })),
  };
}

describe("indexToolResult — knowledge hits", () => {
  it("captures every chunk from a search_knowledge data payload", () => {
    const idx = emptyIndex();
    const res = makeKnowledgeToolResult([
      { chunkId: "c1", documentId: "d1", documentTitle: "Return Policy", documentVersion: 3, section: "Damaged", tier: "HIGH" },
      { chunkId: "c2", documentId: "d1", documentTitle: "Return Policy", documentVersion: 3, tier: "MEDIUM" },
    ]);
    indexToolResult(idx, res.data);
    expect(idx.knowledgeChunks.size).toBe(2);
    expect(idx.knowledgeChunks.get("c1")!.title).toBe("Return Policy");
    expect(idx.knowledgeChunks.get("c1")!.section).toBe("Damaged");
    expect(idx.knowledgeChunks.get("c2")!.tier).toBe("MEDIUM");
  });

  it("does not add chunks with missing required fields", () => {
    const idx = emptyIndex();
    indexToolResult(idx, {
      hits: [
        { chunkId: "c1" }, // missing documentId, title, etc.
        { chunkId: "c2", documentId: "d2", documentTitle: "T", documentVersion: 1, tier: "HIGH" },
      ],
    });
    expect(idx.knowledgeChunks.size).toBe(1);
    expect(idx.knowledgeChunks.has("c1")).toBe(false);
    expect(idx.knowledgeChunks.has("c2")).toBe(true);
  });
});

describe("enforceGrounding — knowledge citations", () => {
  it("rewrites stub citations with server-side title/version/section/tier", () => {
    const idx = emptyIndex();
    indexToolResult(
      idx,
      makeKnowledgeToolResult([
        { chunkId: "c1", documentId: "d1", documentTitle: "Return Policy", documentVersion: 3, section: "Damaged Products", tier: "HIGH" },
      ]).data,
    );
    const { blocks, report } = enforceGrounding([kaBlock(["c1"])], idx);
    expect(blocks).toHaveLength(1);
    const ka = blocks[0] as KnowledgeAnswerBlock;
    expect(ka.sources).toHaveLength(1);
    expect(ka.sources[0]!.title).toBe("Return Policy");
    expect(ka.sources[0]!.version).toBe(3);
    expect(ka.sources[0]!.section).toBe("Damaged Products");
    expect(ka.sources[0]!.tier).toBe("HIGH");
    expect(report.droppedKnowledgeCitations).toHaveLength(0);
  });

  it("DROPS a citation whose chunkId wasn't retrieved", () => {
    const idx = emptyIndex();
    indexToolResult(
      idx,
      makeKnowledgeToolResult([
        { chunkId: "real-1", documentId: "d1", documentTitle: "T", documentVersion: 1, tier: "HIGH" },
      ]).data,
    );
    const { blocks, report } = enforceGrounding([kaBlock(["real-1", "fabricated-chunk"])], idx);
    const ka = blocks[0] as KnowledgeAnswerBlock;
    expect(ka.sources.map((s) => s.chunkId)).toEqual(["real-1"]);
    expect(report.droppedKnowledgeCitations).toEqual([
      { chunkId: "fabricated-chunk", reason: "chunk_id_not_in_retrieval_index" },
    ]);
  });

  it("DROPS the entire KnowledgeAnswer block when every citation is fabricated", () => {
    const idx = emptyIndex();
    indexToolResult(
      idx,
      makeKnowledgeToolResult([
        { chunkId: "real-1", documentId: "d1", documentTitle: "T", documentVersion: 1, tier: "HIGH" },
      ]).data,
    );
    const { blocks, report } = enforceGrounding(
      [kaBlock(["fake-1", "fake-2"]), { kind: "text", text: "see above" } as AiBlock],
      idx,
    );
    // Only the text block survives.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("text");
    expect(report.droppedKnowledgeAnswers).toHaveLength(1);
    expect(report.droppedKnowledgeCitations).toHaveLength(2);
  });

  it("drops NONE-tier citations even when the chunkId is valid", () => {
    const idx = emptyIndex();
    indexToolResult(
      idx,
      makeKnowledgeToolResult([
        { chunkId: "c1", documentId: "d1", documentTitle: "T", documentVersion: 1, tier: "HIGH" },
        { chunkId: "c2", documentId: "d2", documentTitle: "T2", documentVersion: 2, tier: "NONE" },
      ]).data,
    );
    const { blocks, report } = enforceGrounding([kaBlock(["c1", "c2"])], idx);
    const ka = blocks[0] as KnowledgeAnswerBlock;
    expect(ka.sources).toHaveLength(1);
    expect(ka.sources[0]!.chunkId).toBe("c1");
    expect(report.droppedKnowledgeCitations).toEqual([
      { chunkId: "c2", reason: "below_confidence_threshold" },
    ]);
  });
});
