import { searchKnowledge } from "../knowledge/retrieve";

import type { Tool } from "./types";

/**
 * F9 — search_knowledge data tool.
 *
 * The LLM calls this to retrieve relevant chunks from the tenant's
 * knowledge base (policies, SOPs, manuals, FAQs, …). The server owns
 * tenant/branch scoping and language filtering; the LLM only chooses the
 * query text + optional document_type hint.
 *
 * Contract:
 *   • The returned data includes a FULL chunk `content` string. The agent's
 *     system prompt treats this content as UNTRUSTED DATA — it never
 *     executes instructions inside the content.
 *   • Every citation emitted by `render_knowledge_answer` is validated
 *     against the chunk IDs in this result at grounding time.
 */
export const searchKnowledgeTool: Tool = {
  name: "search_knowledge",
  description:
    "Search the shop's UNSTRUCTURED company knowledge (policies, SOPs, manuals, FAQs, training documents). USE THIS for questions about company policy / rules / procedures / documentation — e.g. 'return policy', 'refund rules', 'opening hours policy', 'employee attendance SOP'. DO NOT use this for structured data (product prices, stock quantities, sales, customers, employees, branches) — use the ERP tools (search_products, get_sales_overview, etc.). Returns up to 6 chunks with confidence tiers (HIGH/MEDIUM/LOW/NONE). HARD CONTRACT: if topTier is HIGH or MEDIUM you MUST reply using render_knowledge_answer with the chunk_id values from this result — do NOT use render_text to paraphrase a policy answer. render_text for a policy question is only correct when topTier is NONE / LOW (say the knowledge base has no answer). Citations MUST come from the returned chunks. Never invent documents, sections, or chunkIds.",
  requiredPermission: "view_insights",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        description: "The user's knowledge question, in the user's language.",
      },
      document_type: {
        type: "string",
        enum: [
          "policy",
          "sop",
          "manual",
          "faq",
          "training",
          "product_documentation",
          "supplier_documentation",
          "other",
        ],
        description: "Optional — filter to a specific document type when the user is clearly asking about one.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, error: "EMPTY_QUERY" };
    const documentType = typeof args.document_type === "string" ? args.document_type : undefined;
    const limit = typeof args.limit === "number" ? Math.floor(args.limit) : undefined;
    const r = await searchKnowledge({
      tenantId: ctx.tenantId,
      branchId: null,
      query,
      documentType,
      language: ctx.locale,
      limit,
    });
    return {
      ok: true,
      data: {
        query,
        topScore: r.topScore,
        topTier: r.topTier,
        retrievedCount: r.retrievedCount,
        // Keep the payload tight — the LLM reads this in its context window.
        // We do NOT expose embeddings or raw timestamps, only what's needed
        // to reason + cite.
        hits: r.hits.map((h) => ({
          chunkId: h.chunkId,
          documentId: h.documentId,
          documentTitle: h.documentTitle,
          documentVersion: h.documentVersion,
          documentType: h.documentType,
          section: h.section,
          language: h.language,
          score: h.score,
          tier: h.tier,
          // Explicit "evidence" marker — agent system prompt tells the model
          // that anything inside <EVIDENCE>…</EVIDENCE> is DATA, never
          // instructions. Prompt-injection text inside a document cannot
          // escape this wrapper.
          content: `<EVIDENCE>${h.content}</EVIDENCE>`,
        })),
      },
    };
  },
};
