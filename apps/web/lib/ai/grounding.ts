import type {
  AiBlock,
  ClarificationBlock,
  ComparisonBlock,
  KnowledgeAnswerBlock,
  KnowledgeSource,
  ProductCardBlock,
} from "./responses";

/**
 * F3 — Grounded Answer Policy enforcement.
 *
 * Validates that every business-fact block in the final response is backed
 * by data the agent actually retrieved this turn. The model's system prompt
 * forbids inventing product_ids, but the model is not a security boundary;
 * this guard is the enforceable check.
 *
 * Scope:
 *   • product_card.productId MUST appear in the tool-result index. Otherwise
 *     the block is DROPPED (not sent to the mobile client) and a warning
 *     logged. Dropping — not rewriting — is deliberate: a fabricated product
 *     has no safe repair; the user is better off with an honest gap.
 *   • F4: clarification.options and comparison.entities carry entity uuids.
 *     Any option/entity whose uuid wasn't surfaced this turn is dropped. If
 *     doing so leaves a clarification with <2 options or a comparison with
 *     <2 entities, the whole block is dropped.
 *
 * Future scope (deferred to later F-waves):
 *   • render_text claims — regex-detect "price = X EGP" / "السعر X جنيه" and
 *     verify X matches a value from a tool result (F-plan §11).
 *   • render_table / render_chart values — cross-check against tool JSON.
 */

export interface KnowledgeChunkMeta {
  documentId: string;
  title: string;
  version: number;
  section: string | null;
  tier: "HIGH" | "MEDIUM" | "LOW" | "NONE";
}

export interface ToolResultIndex {
  /** Every product uuid the resolver surfaced this turn (search_products +
   *  get_product). Populated as tool calls execute. */
  productIds: Set<string>;
  /** F9 — every knowledge chunk retrieved this turn, keyed by chunkId. Used
   *  to validate citations in render_knowledge_answer. */
  knowledgeChunks: Map<string, KnowledgeChunkMeta>;
}

export function emptyIndex(): ToolResultIndex {
  return { productIds: new Set(), knowledgeChunks: new Map() };
}

/**
 * Walk a tool result shape and add every grounded uuid to the index. We look
 * for three nesting patterns our current tools emit:
 *   • `data.candidates: [{id, …}]`         → search_products
 *   • `data.product.id`                     → get_product (not yet used but ready)
 *   • top-level `.id`                       → generic
 */
export function indexToolResult(index: ToolResultIndex, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const anyRaw = raw as Record<string, unknown>;
  const data = (anyRaw.data as Record<string, unknown> | undefined) ?? anyRaw;
  if (!data || typeof data !== "object") return;

  const candidates = (data as Record<string, unknown>).candidates;
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") {
        index.productIds.add((c as { id: string }).id);
      }
    }
  }
  const product = (data as Record<string, unknown>).product;
  if (product && typeof product === "object" && typeof (product as { id?: unknown }).id === "string") {
    index.productIds.add((product as { id: string }).id);
  }
  const bareId = (data as Record<string, unknown>).id;
  if (typeof bareId === "string") index.productIds.add(bareId);

  // F9 — knowledge chunk index. search_knowledge returns `hits: [{chunkId, …}]`.
  const hits = (data as Record<string, unknown>).hits;
  if (Array.isArray(hits)) {
    for (const h of hits) {
      if (!h || typeof h !== "object") continue;
      const rec = h as Record<string, unknown>;
      const chunkId = typeof rec.chunkId === "string" ? rec.chunkId : null;
      const documentId = typeof rec.documentId === "string" ? rec.documentId : null;
      const title = typeof rec.documentTitle === "string" ? rec.documentTitle : null;
      const version = typeof rec.documentVersion === "number" ? rec.documentVersion : null;
      const section = typeof rec.section === "string" ? rec.section : null;
      const tier =
        rec.tier === "HIGH" || rec.tier === "MEDIUM" || rec.tier === "LOW" || rec.tier === "NONE"
          ? (rec.tier as KnowledgeChunkMeta["tier"])
          : null;
      if (chunkId && documentId && title && version != null && tier) {
        index.knowledgeChunks.set(chunkId, { documentId, title, version, section, tier });
      }
    }
  }
}

export interface GroundingReport {
  droppedProductCards: Array<{ productId: string; name: string }>;
  droppedClarificationOptions: Array<{ entityId: string; label: string }>;
  droppedClarifications: Array<{ title: string; reason: string }>;
  droppedComparisonEntities: Array<{ entityId: string; label: string }>;
  droppedComparisons: Array<{ title: string; reason: string }>;
  droppedKnowledgeCitations: Array<{ chunkId: string; reason: string }>;
  droppedKnowledgeAnswers: Array<{ reason: string }>;
}

function emptyReport(): GroundingReport {
  return {
    droppedProductCards: [],
    droppedClarificationOptions: [],
    droppedClarifications: [],
    droppedComparisonEntities: [],
    droppedComparisons: [],
    droppedKnowledgeCitations: [],
    droppedKnowledgeAnswers: [],
  };
}

/**
 * Enforce the grounded contract on the final block list. Returns the
 * cleaned blocks + a report naming anything we dropped (for observability).
 */
export function enforceGrounding(
  blocks: AiBlock[],
  index: ToolResultIndex,
): { blocks: AiBlock[]; report: GroundingReport } {
  const report = emptyReport();
  const cleaned: AiBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "product_card") {
      const pc = b as ProductCardBlock;
      if (!index.productIds.has(pc.productId)) {
        report.droppedProductCards.push({ productId: pc.productId, name: pc.name });
        continue;
      }
    } else if (b.kind === "clarification" && b.entityType === "product") {
      const cl = b as ClarificationBlock;
      const kept = cl.options.filter((o) => {
        if (index.productIds.has(o.entityId)) return true;
        report.droppedClarificationOptions.push({
          entityId: o.entityId,
          label: o.label,
        });
        return false;
      });
      if (kept.length < 2) {
        report.droppedClarifications.push({
          title: cl.title,
          reason: "insufficient_grounded_options",
        });
        continue;
      }
      cleaned.push({ ...cl, options: kept });
      continue;
    } else if (b.kind === "comparison" && b.entityType === "product") {
      const cmp = b as ComparisonBlock;
      const kept = cmp.entities.filter((e) => {
        if (index.productIds.has(e.entityId)) return true;
        report.droppedComparisonEntities.push({
          entityId: e.entityId,
          label: e.label,
        });
        return false;
      });
      if (kept.length < 2) {
        report.droppedComparisons.push({
          title: cmp.title,
          reason: "insufficient_grounded_entities",
        });
        continue;
      }
      const keptIds = new Set(kept.map((e) => e.entityId));
      const trimmedValues: ComparisonBlock["values"] = {};
      for (const [attrKey, row] of Object.entries(cmp.values)) {
        trimmedValues[attrKey] = Object.fromEntries(
          Object.entries(row).filter(([id]) => keptIds.has(id)),
        );
      }
      const trimmedAttributes = cmp.attributes.map((a) =>
        a.winnerEntityId && !keptIds.has(a.winnerEntityId)
          ? { ...a, winnerEntityId: null }
          : a,
      );
      cleaned.push({
        ...cmp,
        entities: kept,
        values: trimmedValues,
        attributes: trimmedAttributes,
      });
      continue;
    } else if (b.kind === "knowledge_answer") {
      const ka = b as KnowledgeAnswerBlock;
      const validated: KnowledgeSource[] = [];
      for (const s of ka.sources) {
        const meta = index.knowledgeChunks.get(s.chunkId);
        if (!meta) {
          report.droppedKnowledgeCitations.push({
            chunkId: s.chunkId,
            reason: "chunk_id_not_in_retrieval_index",
          });
          continue;
        }
        // NONE-tier is "not enough evidence"; refuse to cite it.
        if (meta.tier === "NONE") {
          report.droppedKnowledgeCitations.push({
            chunkId: s.chunkId,
            reason: "below_confidence_threshold",
          });
          continue;
        }
        validated.push({
          documentId: meta.documentId,
          chunkId: s.chunkId,
          title: meta.title,
          version: meta.version,
          section: meta.section,
          tier: meta.tier,
        });
      }
      if (validated.length === 0) {
        // No valid sources — the whole block is a fabrication risk.
        report.droppedKnowledgeAnswers.push({ reason: "all_citations_dropped" });
        continue;
      }
      cleaned.push({ ...ka, sources: validated });
      continue;
    }
    cleaned.push(b);
  }
  return { blocks: cleaned, report };
}
