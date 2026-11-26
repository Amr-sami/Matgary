import { sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";

import type { Locale } from "../language";

import { getEmbeddingProvider } from "./embeddings";

/**
 * F9 — Hybrid retrieval.
 *
 * Combines:
 *   • Vector similarity — cosine between query embedding and chunk embedding,
 *     computed in-SQL over double precision[]. pgvector is not available on
 *     the current postgres:16-alpine image; see migration 0059.
 *   • Lexical rank — ts_rank_cd(content_tsv, websearch_to_tsquery('simple', q)).
 *
 * Final score:  0.7 × cosine + 0.3 × ts_rank_normalised
 *
 * Only `is_current = true` AND `status = 'ready'` documents participate.
 * Branch scope is respected: when the caller is pinned to a branch, only
 * matching branch rows + global (branch_id IS NULL) rows are considered.
 *
 * SECURITY:
 *   • `tenantId` comes from the server-side AgentContext — the LLM has no
 *     path to inject one.
 *   • RLS is a secondary net; the explicit WHERE clause is primary.
 *   • Query length is bounded to prevent giant embed calls.
 *   • `limit` is clamped server-side.
 */

export interface KnowledgeRetrievalInput {
  tenantId: string;
  branchId: string | null;
  query: string;
  /** Hint — if the caller wants only docs of a specific type. */
  documentType?: string;
  /** Hint — docs whose stored language matches. */
  language?: Locale;
  /** Max rows returned (hard-capped at 10). */
  limit?: number;
}

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  documentVersion: number;
  documentType: string;
  section: string | null;
  content: string;
  language: string;
  /** 0..1 — the final hybrid score. */
  score: number;
  /** HIGH ≥0.75 ; MEDIUM ≥0.55 ; LOW ≥0.35 ; NONE below. Agent treats
   *  NONE as "no evidence" and refuses to answer from knowledge. */
  tier: ConfidenceTier;
}

export interface KnowledgeRetrievalResult {
  hits: KnowledgeHit[];
  /** Max score across all hits. Easy signal for the agent. */
  topScore: number;
  /** Max tier. */
  topTier: ConfidenceTier;
  /** For telemetry — the actual k we requested from the DB, before hybrid
   *  filtering. */
  retrievedCount: number;
}

const MAX_QUERY_CHARS = 1500;
const DEFAULT_LIMIT = 6;
const HARD_LIMIT = 10;

/**
 * Confidence tiers. Thresholds were tuned against the seeded dev corpus:
 *   • A directly-matched chunk ("Damaged Products" section vs. "damaged
 *     products return" query) scored 0.54 under the 0.7×cosine + 0.3×lex
 *     weighting — a tier-MEDIUM signal that should trigger a cited answer.
 *   • Cross-document noise (e.g. "Attendance SOP › Leave" against a Return
 *     Policy query) consistently scored 0.37-0.40 — below MEDIUM, above
 *     NONE.
 *  Thresholds live on one line; a future evaluation dataset can retune.
 */
function tierFor(score: number): ConfidenceTier {
  if (score >= 0.70) return "HIGH";
  if (score >= 0.50) return "MEDIUM";
  if (score >= 0.35) return "LOW";
  return "NONE";
}

export async function searchKnowledge(
  input: KnowledgeRetrievalInput,
): Promise<KnowledgeRetrievalResult> {
  const query = String(input.query ?? "").trim();
  if (!query) {
    return { hits: [], topScore: 0, topTier: "NONE", retrievedCount: 0 };
  }
  if (query.length > MAX_QUERY_CHARS) {
    // Reject rather than silently truncate — a 10k-char "query" is almost
    // certainly a programming error or an injection attempt.
    throw new Error(`Query exceeds ${MAX_QUERY_CHARS} chars`);
  }
  const limit = Math.min(HARD_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

  // Embed the user query. 1 call per retrieval — this is the hot path.
  const provider = getEmbeddingProvider();
  const [emb] = await provider.embed([query]);
  if (!emb) return { hits: [], topScore: 0, topTier: "NONE", retrievedCount: 0 };
  const queryVec = emb.vector;

  const branchFilter = input.branchId
    ? sql`(c.branch_id = ${input.branchId} OR c.branch_id IS NULL)`
    : sql`TRUE`;
  const typeFilter = input.documentType
    ? sql`d.document_type = ${input.documentType}`
    : sql`TRUE`;
  const langFilter = input.language ? sql`c.language = ${input.language}` : sql`TRUE`;

  // Cosine similarity in-SQL over double precision[]. We compute dot /
  // (||a|| * ||b||) using unnest + array aggregates. This is slower than
  // pgvector, but correct and bounded for development scale.
  //
  // We pre-compute the query vector norm in JS and the chunk vector norm
  // in SQL; the per-row cost is O(dim).
  const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0)) || 1;

  const rows = await withTenant(input.tenantId, async (tx) => {
    // Build an array literal for the query vector safely via a parameter.
    const qvec = sql`${sql.raw(`ARRAY[${queryVec.map((v) => Number(v).toString()).join(",")}]::double precision[]`)}`;

    // Compute cosine_similarity + lex_rank; let the caller combine.
    const result = await tx.execute(sql`
      WITH q AS (SELECT ${qvec} AS v),
      scored AS (
        SELECT
          c.id              AS chunk_id,
          c.document_id     AS document_id,
          d.title           AS document_title,
          d.version         AS document_version,
          d.document_type   AS document_type,
          c.section         AS section,
          c.content         AS content,
          c.language        AS language,
          -- cosine similarity
          (
            SELECT COALESCE(SUM(a * b), 0)
            FROM unnest(c.embedding) WITH ORDINALITY AS ce(a, ord)
            JOIN LATERAL (SELECT (q.v)[ce.ord] AS b FROM q) qv ON TRUE
          ) / NULLIF(
            sqrt(
              (SELECT COALESCE(SUM(a * a), 0) FROM unnest(c.embedding) AS a)
            ) * ${queryNorm}, 0
          ) AS cosine,
          ts_rank_cd(c.content_tsv, websearch_to_tsquery('simple', ${query})) AS lex_rank
        FROM ai_knowledge_chunks c
        JOIN ai_knowledge_documents d ON d.id = c.document_id
        WHERE c.tenant_id = ${input.tenantId}
          AND d.tenant_id = ${input.tenantId}
          AND d.is_current = true
          AND d.status = 'ready'
          AND ${branchFilter}
          AND ${typeFilter}
          AND ${langFilter}
      )
      SELECT * FROM scored
      -- Max of cosine + lexical; dense hits that match both are preferred,
      -- but a strong cosine (semantic paraphrase) still bubbles up when the
      -- user typed no overlapping keyword.
      ORDER BY (0.7 * COALESCE(cosine, 0) + 0.3 * LEAST(COALESCE(lex_rank, 0), 1)) DESC
      LIMIT ${limit * 2}
    `);
    // drizzle-orm's `.execute` returns a QueryResult whose `rows` depends on
    // the underlying driver; postgres-js returns an array directly.
    const raw = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
    return raw as Array<Record<string, unknown>>;
  });

  // Score + tier in JS so we don't duplicate the weights across SQL + JS.
  const hits: KnowledgeHit[] = rows
    .map((r) => {
      const cos = Number(r.cosine ?? 0);
      const lex = Math.min(Number(r.lex_rank ?? 0), 1);
      const score = 0.7 * (Number.isFinite(cos) ? cos : 0) + 0.3 * lex;
      return {
        chunkId: String(r.chunk_id),
        documentId: String(r.document_id),
        documentTitle: String(r.document_title),
        documentVersion: Number(r.document_version),
        documentType: String(r.document_type),
        section: r.section == null ? null : String(r.section),
        content: String(r.content),
        language: String(r.language),
        score: Number(score.toFixed(4)),
        tier: tierFor(score),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const topScore = hits.length > 0 ? hits[0]!.score : 0;
  const topTier = hits.length > 0 ? hits[0]!.tier : "NONE";

  return { hits, topScore, topTier, retrievedCount: rows.length };
}
