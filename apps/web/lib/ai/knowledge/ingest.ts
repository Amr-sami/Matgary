import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  aiKnowledgeChunks,
  aiKnowledgeDocuments,
  type AiKnowledgeDocumentRow,
} from "@/lib/db/schema";

import { classifyText, type Locale } from "../language";

import { chunkText } from "./chunk";
import { getEmbeddingProvider } from "./embeddings";
import { detectKnowledgeFormat, extractDocx, extractPdf, ExtractError } from "./extract";

/**
 * F9 — Document ingestion pipeline.
 *
 * Flow:
 *   1. Validate input (title, body, tenant).
 *   2. Hash content → skip re-ingestion of identical content.
 *   3. Detect language if not provided.
 *   4. Row insert with status='processing'.
 *   5. Chunk → embed → batch insert chunks.
 *   6. Flip status to 'ready' + stamp updatedAt.
 *   7. On any step failure → status='failed' + statusDetail + throw.
 *
 * SAFETY — ingestion runs inside `withTenant`, so every INSERT carries the
 * tenant_id and RLS is enforced server-side. The LLM has no path to call
 * this.
 */

export type DocumentType =
  | "policy"
  | "sop"
  | "manual"
  | "faq"
  | "training"
  | "product_documentation"
  | "supplier_documentation"
  | "other";

export type SupportedMime =
  | "text/plain"
  | "text/markdown"
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface IngestInput {
  tenantId: string;
  branchId?: string | null;
  title: string;
  description?: string;
  documentType: DocumentType;
  /** F10.2 — for TXT/MD callers pass the file body as a string here. For
   *  PDF/DOCX callers pass `bodyBuffer` instead; the engine extracts the
   *  text internally via lib/ai/knowledge/extract.ts. Exactly one of
   *  `body` / `bodyBuffer` must be provided. */
  body?: string;
  /** F10.2 — raw file bytes for binary formats. */
  bodyBuffer?: Buffer;
  /** Optional — detected from text when absent. */
  language?: Locale;
  fileName?: string;
  mimeType?: SupportedMime | string;
  source?: "upload" | "seed" | "api";
  createdBy?: string | null;
  /** When true (default), supersede any prior is_current=true document with
   *  the SAME title in the same tenant: the prior row is flipped to
   *  is_current=false and status='archived'. */
  supersede?: boolean;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  documentId: string;
  version: number;
  chunksCreated: number;
  status: "ready" | "skipped_identical_content";
}

export class IngestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB per document (PDF/DOCX run larger than TXT)

export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const { tenantId, title } = input;
  if (!tenantId) throw new IngestError("INVALID_INPUT", "tenantId is required");
  if (!title || !title.trim()) throw new IngestError("INVALID_INPUT", "title is required");

  const hasBody = typeof input.body === "string" && input.body.trim().length > 0;
  const hasBuffer = Buffer.isBuffer(input.bodyBuffer) && input.bodyBuffer.length > 0;
  if (!hasBody && !hasBuffer) {
    throw new IngestError("EMPTY_BODY", "Document body is empty");
  }
  if (hasBody && hasBuffer) {
    throw new IngestError("INVALID_INPUT", "Provide either body or bodyBuffer, not both");
  }

  // Resolve format from filename + MIME and extract text for binary formats.
  const format = detectKnowledgeFormat(input.fileName ?? "", input.mimeType);
  let rawText: string;
  let extractMeta: Record<string, unknown> | null = null;

  if (hasBuffer) {
    const buf = input.bodyBuffer!;
    if (buf.length > MAX_BODY_BYTES) {
      throw new IngestError(
        "BODY_TOO_LARGE",
        `File exceeds ${MAX_BODY_BYTES} bytes`,
      );
    }
    try {
      if (format === "pdf") {
        const r = await extractPdf(buf);
        rawText = r.text;
        extractMeta = r.metadata;
      } else if (format === "docx") {
        const r = await extractDocx(buf);
        rawText = r.text;
        extractMeta = r.metadata;
      } else if (format === "text" || format === "markdown") {
        rawText = buf.toString("utf8");
      } else {
        throw new IngestError(
          "UNSUPPORTED_MIME",
          `File format for "${input.fileName ?? "?"}" (mime=${input.mimeType ?? "?"}) is not supported`,
        );
      }
    } catch (e) {
      if (e instanceof IngestError) throw e;
      if (e instanceof ExtractError) {
        throw new IngestError(e.code, e.message);
      }
      throw new IngestError(
        "EXTRACTION_FAILED",
        e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    rawText = input.body!;
    if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
      throw new IngestError("BODY_TOO_LARGE", `Body exceeds ${MAX_BODY_BYTES} bytes`);
    }
  }

  if (!rawText.trim()) {
    throw new IngestError("EMPTY_BODY", "Extracted body is empty");
  }

  const normalised = normaliseBody(rawText);
  const hash = sha256(normalised);
  const language = input.language ?? detectDocumentLocale(normalised);
  const mime = (input.mimeType ?? "text/plain").toLowerCase();

  // Check for identical content from a prior ingestion. Hash is per-tenant.
  const existingHash = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: aiKnowledgeDocuments.id, version: aiKnowledgeDocuments.version })
      .from(aiKnowledgeDocuments)
      .where(
        and(
          eq(aiKnowledgeDocuments.tenantId, tenantId),
          eq(aiKnowledgeDocuments.title, title),
          eq(aiKnowledgeDocuments.contentHash, hash),
          eq(aiKnowledgeDocuments.isCurrent, true),
          eq(aiKnowledgeDocuments.status, "ready"),
        ),
      );
    return row ?? null;
  });
  if (existingHash) {
    return {
      documentId: existingHash.id,
      version: existingHash.version,
      chunksCreated: 0,
      status: "skipped_identical_content",
    };
  }

  // Supersede previous version with the same title (default behavior).
  // Compute the next version number.
  const nextVersion = await withTenant(tenantId, async (tx) => {
    if (input.supersede === false) return 1;
    const prior = await tx
      .select({ version: aiKnowledgeDocuments.version })
      .from(aiKnowledgeDocuments)
      .where(
        and(
          eq(aiKnowledgeDocuments.tenantId, tenantId),
          eq(aiKnowledgeDocuments.title, title),
        ),
      )
      .orderBy(sql`${aiKnowledgeDocuments.version} desc`)
      .limit(1);
    return (prior[0]?.version ?? 0) + 1;
  });

  // Flip prior current to archived, then insert the new row in 'processing'.
  const doc = await withTenant(tenantId, async (tx) => {
    if (input.supersede !== false) {
      await tx
        .update(aiKnowledgeDocuments)
        .set({ isCurrent: false, status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(aiKnowledgeDocuments.tenantId, tenantId),
            eq(aiKnowledgeDocuments.title, title),
            eq(aiKnowledgeDocuments.isCurrent, true),
          ),
        );
    }
    const [row] = await tx
      .insert(aiKnowledgeDocuments)
      .values({
        tenantId,
        branchId: input.branchId ?? null,
        title,
        description: input.description ?? null,
        documentType: input.documentType,
        source: input.source ?? "upload",
        fileName: input.fileName ?? null,
        mimeType: mime,
        language,
        version: nextVersion,
        isCurrent: true,
        status: "processing",
        contentHash: hash,
        // F10.2 — merge extractor metadata (pdf page count, docx warnings, …)
        // so ops can inspect what the extractor saw without re-parsing.
        metadata: { ...(input.metadata ?? {}), ...(extractMeta ?? {}) },
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row!;
  });

  try {
    const chunks = chunkText(normalised);
    if (chunks.length === 0) {
      await markFailed(tenantId, doc.id, "EMPTY_CHUNKS");
      throw new IngestError("EMPTY_CHUNKS", "No chunkable content produced");
    }
    const provider = getEmbeddingProvider();
    const embeddings = await provider.embed(chunks.map((c) => c.content));
    if (embeddings.length !== chunks.length) {
      await markFailed(tenantId, doc.id, "EMBEDDING_COUNT_MISMATCH");
      throw new IngestError(
        "EMBEDDING_COUNT_MISMATCH",
        `embeddings=${embeddings.length} chunks=${chunks.length}`,
      );
    }

    await withTenant(tenantId, async (tx) => {
      // Insert all chunks in one batch. Postgres can handle 50-100 chunk
      // batches comfortably; a huge doc (hundreds of chunks) would need
      // batching but is out of F9 scope.
      await tx.insert(aiKnowledgeChunks).values(
        chunks.map((c, i) => ({
          tenantId,
          branchId: input.branchId ?? null,
          documentId: doc.id,
          documentVersion: nextVersion,
          chunkIndex: c.index,
          section: c.section,
          language,
          content: c.content,
          embedding: embeddings[i]!.vector,
          embeddingModel: `${provider.name}-${provider.model}`,
          tokenCount: Math.ceil(c.content.length / 4), // rough estimate
        })),
      );
      await tx
        .update(aiKnowledgeDocuments)
        .set({ status: "ready", updatedAt: new Date() })
        .where(eq(aiKnowledgeDocuments.id, doc.id));
    });

    return {
      documentId: doc.id,
      version: nextVersion,
      chunksCreated: chunks.length,
      status: "ready",
    };
  } catch (err) {
    if (err instanceof IngestError) throw err;
    await markFailed(tenantId, doc.id, err instanceof Error ? err.message : "unknown");
    throw err;
  }
}

async function markFailed(tenantId: string, docId: string, reason: string) {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(aiKnowledgeDocuments)
        .set({ status: "failed", statusDetail: reason, updatedAt: new Date() })
        .where(eq(aiKnowledgeDocuments.id, docId));
    });
  } catch {
    /* non-fatal */
  }
}

/* ───────────────────────── helpers ──────────────────────────────────── */

function normaliseBody(s: string): string {
  // Preserve Unicode; strip NUL and control chars other than newline/tab.
  return s.replace(/[ --]/g, "");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function detectDocumentLocale(text: string): Locale {
  // Reuse the F7 detector. Return the sample's classification; default to EN
  // when ambiguous (a mixed-script policy is usually in English with Latin
  // brand names).
  const probe = text.slice(0, 2000);
  const c = classifyText(probe);
  return c === "unknown" ? "en" : c;
}

/* ───────────────────────── read helpers ──────────────────────────────── */

export async function listDocuments(opts: {
  tenantId: string;
  branchId?: string | null;
  onlyCurrent?: boolean;
  status?: AiKnowledgeDocumentRow["status"];
}): Promise<AiKnowledgeDocumentRow[]> {
  return withTenant(opts.tenantId, async (tx) => {
    let query = tx
      .select()
      .from(aiKnowledgeDocuments)
      .where(eq(aiKnowledgeDocuments.tenantId, opts.tenantId))
      .$dynamic();
    if (opts.onlyCurrent !== false) {
      query = query.where(eq(aiKnowledgeDocuments.isCurrent, true));
    }
    if (opts.status) {
      query = query.where(eq(aiKnowledgeDocuments.status, opts.status));
    }
    return query.orderBy(sql`${aiKnowledgeDocuments.createdAt} desc`);
  });
}

export async function archiveDocument(tenantId: string, documentId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .update(aiKnowledgeDocuments)
      .set({ status: "archived", isCurrent: false, updatedAt: new Date() })
      .where(
        and(
          eq(aiKnowledgeDocuments.id, documentId),
          eq(aiKnowledgeDocuments.tenantId, tenantId),
        ),
      )
      .returning({ id: aiKnowledgeDocuments.id });
    return !!row;
  });
}
