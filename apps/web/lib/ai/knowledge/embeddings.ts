import { GoogleGenAI } from "@google/genai";

/**
 * F9 — Embedding provider abstraction.
 *
 * Agent-level code never constructs or calls Gemini directly for embeddings.
 * Ingestion + retrieval call `getEmbeddingProvider().embed([...])` through
 * this interface so we can add a secondary provider later (e.g. a local
 * MiniLM for offline dev) without rippling changes into the pipeline.
 *
 * SAFETY:
 *   • `embed()` rejects when ANY input is empty / whitespace-only — we never
 *     want a zero-vector ingested alongside real data.
 *   • `dimensions` is a provider contract the caller can rely on when
 *     building vector DDL (we persist 768 in the schema for Gemini).
 *   • No prompt-injection surface — embeddings DO NOT execute instructions.
 */

export interface Embedding {
  /** The raw vector. Length === `dimensions`. */
  vector: number[];
  /** Length of the input, for ops telemetry — never the input itself. */
  inputCharCount: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** Batched embed. Preserves order. Throws on empty input. */
  embed(inputs: string[]): Promise<Embedding[]>;
}

/* ─────────────────────── Gemini ──────────────────────────────────────── */

// `gemini-embedding-001` is what the paid-tier API exposes right now; the
// native dim is 3072, but we request 768 via `outputDimensionality` for
// cosine-in-SQL performance. Swap to pgvector + larger dim if retrieval
// quality demands it.
const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_DIMS = 768;

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly dimensions = DEFAULT_DIMS;
  private readonly client: GoogleGenAI;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async embed(inputs: string[]): Promise<Embedding[]> {
    if (!inputs || inputs.length === 0) return [];
    // Validate up-front so the provider never silently produces a short
    // array of embeddings for a mixed batch. A zero-vector in retrieval
    // scores against every query — we treat it as a load-bearing error.
    for (const [i, s] of inputs.entries()) {
      if (typeof s !== "string" || !s.trim()) {
        throw new Error(`embedding input ${i} is empty`);
      }
    }

    // The SDK takes `contents: string | string[]`. We batch where possible —
    // Gemini supports up to 100 inputs per call on text-embedding-004.
    const BATCH = 100;
    const out: Embedding[] = [];
    for (let i = 0; i < inputs.length; i += BATCH) {
      const slice = inputs.slice(i, i + BATCH);
      const res = await this.client.models.embedContent({
        model: this.model,
        contents: slice,
        config: { outputDimensionality: this.dimensions },
      });
      const embs = extractEmbeddings(res);
      if (embs.length !== slice.length) {
        throw new Error(
          `embedding provider returned ${embs.length} vectors for ${slice.length} inputs`,
        );
      }
      for (let j = 0; j < slice.length; j++) {
        const v = embs[j]!;
        if (v.length !== this.dimensions) {
          throw new Error(
            `embedding dim mismatch: got ${v.length}, expected ${this.dimensions}`,
          );
        }
        out.push({ vector: v, inputCharCount: slice[j]!.length });
      }
    }
    return out;
  }
}

/** The @google/genai response shape wraps vectors in `{ embeddings: [{ values: number[] }] }`.
 *  Older paths return `{ embedding: { values: number[] } }`. We handle both. */
function extractEmbeddings(res: unknown): number[][] {
  if (!res || typeof res !== "object") return [];
  const r = res as Record<string, unknown>;
  const list = (r.embeddings as unknown) ?? (r.embedding as unknown);
  if (Array.isArray(list)) {
    return list.map((e) => {
      const v = (e as { values?: unknown }).values;
      return Array.isArray(v) ? (v as number[]) : [];
    });
  }
  if (list && typeof list === "object") {
    const v = (list as { values?: unknown }).values;
    if (Array.isArray(v)) return [v as number[]];
  }
  return [];
}

/* ─────────────────────── factory ─────────────────────────────────────── */

let _provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (_provider) return _provider;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY not set; the knowledge/RAG layer requires an embedding provider.",
    );
  }
  _provider = new GeminiEmbeddingProvider({ apiKey: key });
  return _provider;
}

/** Test-only — inject a deterministic provider. */
export function setEmbeddingProviderForTests(p: EmbeddingProvider | null): void {
  _provider = p;
}

/* ─────────────────────── math helpers ────────────────────────────────── */

/** Cosine similarity for two same-length vectors. Returns 0 for zero vectors
 *  rather than NaN — safer for retrieval scoring. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}
