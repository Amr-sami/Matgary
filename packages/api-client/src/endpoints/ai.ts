import type { ApiClient } from "../http";

/**
 * AI chat proxy. The mobile client NEVER holds the LLM provider key — every
 * turn goes through /api/ai/chat on the Next.js backend. See
 * apps/web/app/api/ai/chat/route.ts.
 */

export interface AiChatMessage {
  /** "user" is what the shop owner typed; "model" / "assistant" is a prior AI reply. */
  role: "user" | "model" | "assistant";
  content: string;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  /** Optional model override; defaults to the server's GROQ_MODEL. */
  model?: string;
  /** F6 — client-generated conversation id (uuid v4). The server keys its
   *  per-conversation context store by `(tenantId, conversationId)` so
   *  follow-ups like "the second one" can resolve to the previous turn's
   *  real database entities. Omit → a one-shot conversation with no stored
   *  context. */
  conversationId?: string;
}

export interface AiChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Structured response blocks — the agent returns an ORDERED list of these so
 * the mobile UI can render a mix of text, charts, tables, KPI cards and
 * confirmation prompts in one reply. */

export type ChartKind = "line" | "bar" | "pie" | "donut" | "area";

export interface ChartSeries {
  dataKey: string;
  label: string;
  /** Hex. Optional — the renderer falls back to brand accent / palette. */
  color?: string;
}

export interface TextBlock {
  kind: "text";
  text: string;
}

export interface ChartBlock {
  kind: "chart";
  chartType: ChartKind;
  title: string;
  description?: string;
  /** The field in each data row to use for the x-axis / category label.
   *  Required for line/bar/area; optional for pie/donut (first series key). */
  xKey?: string;
  series: ChartSeries[];
  data: Record<string, string | number>[];
  /** ISO currency code (EGP). Used by the renderer for axis / tooltip format. */
  currency?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "start" | "end" | "center";
  /** "money" → formatted with currency; "number" → tabular-nums. */
  format?: "money" | "number" | "text" | "date" | "percent";
}

export interface TableBlock {
  kind: "table";
  title: string;
  description?: string;
  columns: TableColumn[];
  rows: Record<string, string | number | null>[];
  currency?: string;
}

export interface KpiItem {
  label: string;
  value: string;
  /** -N / +N — renderer colors up/down. Omit for neutral. */
  trendPct?: number;
  tone?: "up" | "down" | "neutral";
}

export interface KpiBlock {
  kind: "kpi";
  title?: string;
  items: KpiItem[];
}

export interface ConfirmationBlock {
  kind: "confirmation";
  title: string;
  summary: string;
  actionLabel: string;
  /** HMAC-signed token the mobile client POSTs to /api/ai/confirm. Wave 4. */
  token: string;
  expiresAt: string;
}

/** F-plan §15 — grounded product UI. Every field is sourced from the real
 *  Storo database (via search_products / get_product); the model never
 *  synthesises these. */
export interface ProductCardBlock {
  kind: "product_card";
  productId: string;
  name: string;
  brand: string | null;
  sku: string | null;
  price: number;
  currency: string;
  quantity: number;
  stockState: "in_stock" | "low_stock" | "out_of_stock";
  imageUrl?: string | null;
  caption?: string;
}

/* ─────────────────────────── F4 blocks ───────────────────────────────── */

/** One option in a ClarificationBlock. Carries a REAL entity id and the
 *  follow-up text the mobile app sends back as a new user turn when tapped. */
export interface ClarificationOption {
  entityId: string;
  label: string;
  hint?: string;
  followUpText: string;
}

/** "Which one did you mean?" picker. Tapping an option sends followUpText back
 *  through the normal chat pipeline so F6 context + F5 preview continue
 *  unchanged — no secret back-channel. */
export interface ClarificationBlock {
  kind: "clarification";
  title: string;
  prompt?: string;
  options: ClarificationOption[];
  entityType: "product" | "customer" | "employee" | "generic";
}

export interface ComparisonAttribute {
  label: string;
  format?: "money" | "number" | "text" | "percent";
  winnerEntityId?: string | null;
}

export interface ComparisonEntity {
  entityId: string;
  label: string;
  subtitle?: string;
}

/** Side-by-side comparison matrix of 2–4 entities. Server builds the values
 *  deterministically from tool results; the LLM only requests the block. */
export interface ComparisonBlock {
  kind: "comparison";
  title: string;
  description?: string;
  entityType: "product" | "customer" | "employee" | "generic";
  entities: ComparisonEntity[];
  attributes: ComparisonAttribute[];
  values: Record<string, Record<string, string | number | null>>;
  currency?: string;
}

/** Deterministic inventory headline. */
export interface InventorySummaryBlock {
  kind: "inventory_summary";
  title: string;
  scope?: string;
  totalProducts: number;
  lowStockCount: number;
  outOfStockCount: number;
  stockValue?: number;
  stockValueBasis?: "cost" | "retail";
  currency: string;
  highlights?: Array<{
    productId: string;
    name: string;
    quantity: number;
    state: "low_stock" | "out_of_stock";
  }>;
}

/** Deterministic sales-period headline. */
export interface SalesSummaryBlock {
  kind: "sales_summary";
  title: string;
  periodLabel: string;
  scope?: string;
  revenue: number;
  orders: number;
  averageOrderValue: number;
  currency: string;
  revenueTrendPct?: number | null;
  ordersTrendPct?: number | null;
  topLine?: { label: string; value: string };
}

/** User-visible warning. `code` is a stable SNAKE_CASE identifier for
 *  telemetry (e.g. AUDIT_WRITE_FAILED, METRIC_UNAVAILABLE). */
export interface WarningBlock {
  kind: "warning";
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  code: string;
}

/* ─────────────────────────── F9 — knowledge ─────────────────────────── */

export interface KnowledgeSource {
  documentId: string;
  chunkId: string;
  title: string;
  version: number;
  section: string | null;
  tier: "HIGH" | "MEDIUM" | "LOW";
}

/** Grounded answer from the Knowledge/RAG layer. Every citation has been
 *  verified server-side against the retrieval results of THIS turn — the
 *  mobile UI can render them as tappable source chips with confidence. */
export interface KnowledgeAnswerBlock {
  kind: "knowledge_answer";
  answer: string;
  sources: KnowledgeSource[];
}

/* ─────────────────────────── F10.3 — bulk ops ────────────────────────── */

export interface BulkPreviewChange {
  productId: string;
  name: string;
  beforePrice: number;
  afterPrice: number;
  delta: number;
}

export interface BulkPreviewBlock {
  kind: "bulk_preview";
  operationKind: "product.price.update";
  mode: "set" | "increase_pct" | "decrease_pct" | "increase_by" | "decrease_by";
  value: number;
  totalMatched: number;
  totalEligible: number;
  skippedOverCap: number;
  sampleChanges: BulkPreviewChange[];
  totalPriceDelta: number;
  title: string;
  description: string;
}

export interface BulkResultBlock {
  kind: "bulk_result";
  operationGroupId: string;
  operationKind: "product.price.update";
  updated: number;
  skipped: number;
  failed: number;
  reasons: Array<{ productId: string; code: string; message: string }>;
  title: string;
  message: string;
}

/* ─────────────────────────── F10.1 — import ──────────────────────────── */

export interface ImportPreviewRowSummary {
  rowIndex: number;
  action: "create" | "update" | "skip";
  entityLabel: string;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
}

export interface ImportPreviewBlock {
  kind: "import_preview";
  sessionId: string;
  entityType: string;
  fileName: string;
  totalRows: number;
  toCreate: number;
  toUpdate: number;
  toSkip: number;
  invalid: number;
  ambiguous: number;
  missing: number;
  sampleCreate: ImportPreviewRowSummary[];
  sampleUpdate: ImportPreviewRowSummary[];
  sampleIssues: Array<{ rowIndex: number; status: string; issue: string }>;
  title: string;
  description: string;
}

/** Mirrored from apps/web/lib/ai/responses.ts — keep in sync. */
export type EditableImportFieldType = "text" | "number" | "integer" | "money" | "choice";

export interface EditableImportColumn {
  key: string;
  label: string;
  type: EditableImportFieldType;
  editable: boolean;
  required: boolean;
  choices?: string[];
  minWidth?: number;
}

export interface EditableImportRow {
  rowIndex: number;
  rowId: string;
  status:
    | "valid"
    | "invalid"
    | "ambiguous"
    | "missing"
    | "ready"
    | "imported"
    | "failed"
    | "skipped";
  action: "create" | "update" | "skip" | "none";
  cells: Record<string, string | number | null>;
  existing?: Record<string, string | number | null>;
  issue?: string;
  errors: string[];
}

export interface EditableImportPreviewBlock {
  kind: "editable_import_preview";
  sessionId: string;
  entityType: string;
  fileName: string;
  totalRows: number;
  toCreate: number;
  toUpdate: number;
  toSkip: number;
  invalid: number;
  ambiguous: number;
  missing: number;
  errorCount: number;
  warningCount: number;
  columns: EditableImportColumn[];
  rows: EditableImportRow[];
  title: string;
  description: string;
  readyToConfirm: boolean;
  computedAt: string;
  currency?: string;
}

export interface ImportQuestionBlock {
  kind: "import_question";
  sessionId: string;
  title: string;
  questions: Array<{
    kind: "missing_field" | "ambiguous_field" | "action_for_row" | "other";
    message: string;
    affectedRows: number[];
    field?: string;
    suggestedActions?: string[];
  }>;
}

export interface ImportResultBlock {
  kind: "import_result";
  sessionId: string;
  operationGroupId: string | null;
  fileName: string;
  entityType: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: Array<{ rowIndex: number; reason: string }>;
  title: string;
  message: string;
}

export interface ImportConflictBlock {
  kind: "import_conflict";
  sessionId: string;
  operationGroupId: string;
  reversed: number;
  conflicted: number;
  failed: number;
  reasons: Array<{ operationId: string; code: string; message: string }>;
  title: string;
  message: string;
}

/* ─────────────────────────── F10.0 — rollback ────────────────────────── */

/** Rollback preview — accompanies a ConfirmationBlock with `action: rollback`. */
export interface RollbackPreviewBlock {
  kind: "rollback_preview";
  operationId: string;
  operationType: string;
  entityType: "product" | "customer";
  entityLabel: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  currentState: Record<string, unknown>;
  affectedFields: string[];
  destructive: boolean;
  title: string;
  description: string;
}

/** Rollback executed successfully. */
export interface RollbackResultBlock {
  kind: "rollback_result";
  operationId: string;
  rollbackOperationId: string;
  operationType: string;
  entityType: "product" | "customer";
  entityLabel: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  restoredState: Record<string, unknown>;
  affectedFields: string[];
  title: string;
  message: string;
}

/** Rollback blocked. `kind_detail` is stable for telemetry/UI. */
export interface RollbackConflictBlock {
  kind: "rollback_conflict";
  operationId: string;
  operationType: string;
  entityLabel: string;
  kind_detail:
    | "expired"
    | "already_reverted"
    | "concurrent_change"
    | "dependency_blocked"
    | "not_reversible"
    | "entity_missing"
    | "write_failed"
    | "verify_failed";
  reason: string;
  title: string;
  message: string;
}

export type AiBlock =
  | TextBlock
  | ChartBlock
  | TableBlock
  | KpiBlock
  | ConfirmationBlock
  | ProductCardBlock
  | ClarificationBlock
  | ComparisonBlock
  | InventorySummaryBlock
  | SalesSummaryBlock
  | WarningBlock
  | KnowledgeAnswerBlock
  | RollbackPreviewBlock
  | RollbackResultBlock
  | RollbackConflictBlock
  | ImportPreviewBlock
  | EditableImportPreviewBlock
  | ImportQuestionBlock
  | ImportResultBlock
  | ImportConflictBlock
  | BulkPreviewBlock
  | BulkResultBlock;

export interface AiResponse {
  /** Ordered content blocks the mobile UI renders in sequence. */
  blocks: AiBlock[];
  /** The language the agent locked to for this reply. F7 — one of
   *  ar | en | pt | fr | es, pinned per turn by the server from the user's
   *  dominant language. Mobile uses this for RTL (ar) and locale-aware
   *  number/currency formatting on the block renderers. */
  locale: "ar" | "en" | "pt" | "fr" | "es";
  model: string;
  usage: AiChatUsage;
  /** Names of tools the agent executed this turn. Diagnostic/telemetry only. */
  toolsCalled: string[];
  /** F11 — stable logical id for the entire assistant turn. Minted by the
   *  server at the start of the request and threaded through every internal
   *  event so streaming / retries / fallbacks cannot visually duplicate the
   *  response. Mobile uses it as the AssistantMessage id. Optional for
   *  backwards compatibility. */
  turnId?: string;
}

/* Legacy shape — kept for one release so a stale mobile build still parses.
 * Delete in wave 5. */
export interface LegacyAiChatResponse {
  reply: string;
  model: string;
  usage: AiChatUsage;
}

/**
 * The agent's worst-case: data tool (DB query) + render tool + optional
 * nudge-and-retry round can run 20–40s on the free Groq tier. The default
 * client timeout (15s) was aborting MOST successful runs, which surfaced
 * on mobile as the misleading "couldn't reach the AI" error even though
 * the server had happily finished the request. 90s covers the worst case
 * (3 rounds × ~25s with retry buffer) without masking a real hang.
 */
const AI_CHAT_TIMEOUT_MS = 90_000;

/**
 * Send a chat turn. The caller passes the FULL history on every call — the
 * server is stateless (no per-session state).
 *
 * Errors:
 *  - 503 { error: "AI_DISABLED" } — the key isn't set; caller should hide the AI UI.
 *  - 502 { error: "AI_REQUEST_FAILED", reason } — provider rejected or timed out.
 *  - 503 { error: "AI_BUSY" } — provider overloaded transiently; retryable.
 *  - 400 { error: "..." } — malformed body / empty messages.
 */
export async function chat(client: ApiClient, body: AiChatRequest): Promise<AiResponse> {
  return client.request<AiResponse>("/api/ai/chat", {
    method: "POST",
    body,
    timeoutMs: AI_CHAT_TIMEOUT_MS,
  });
}

/**
 * Execute a previewed AI write — F5.
 *
 * `token` comes from a `confirmation` block the agent returned. The server
 * owns the action parameters; the client supplies only the token.
 *
 * Errors:
 *   • 403 CONFIRMATION_REJECTED — invalid / tampered / cross-tenant token.
 *   • 403 FORBIDDEN            — the action's permission was revoked between
 *     preview and confirm.
 *   • 409 CONFIRMATION_REJECTED (reason: ALREADY_CONSUMED | EXPIRED)
 *   • 409 BRANCH_MISMATCH      — the user switched branches since preview.
 */
export async function confirm(
  client: ApiClient,
  token: string,
  conversationId?: string,
): Promise<AiResponse> {
  return client.request<AiResponse>("/api/ai/confirm", {
    method: "POST",
    body: { token, ...(conversationId ? { conversationId } : {}) },
    timeoutMs: 30_000,
  });
}

/**
 * F10.1 — Upload a data-import file.
 *
 * `bodyBase64` is the file bytes base64-encoded. The server caps uploads at
 * 2 MiB and validates MIME + extension + magic. On success the server returns
 * the import session id; the mobile chat screen then sends a user message
 * referencing that session so the agent calls `inspect_import`.
 *
 * Errors:
 *   • 400 INVALID_BODY / FILE_TOO_LARGE / PARSE_FAILED / UNSUPPORTED_FORMAT …
 *     — the mobile client renders a localized banner.
 *   • 401/403 — standard F1-era handling.
 */
export interface ImportUploadRequest {
  fileName: string;
  mimeType: string;
  /** base64-encoded file bytes. */
  bodyBase64: string;
  conversationId?: string;
}

export interface ImportUploadResponse {
  sessionId: string;
  status: string;
  entityType: string;
  reusedExisting: boolean;
  counts: {
    rowCount: number;
    valid: number;
    invalid: number;
    ambiguous: number;
    missing: number;
  };
  fieldMapping: Record<string, string>;
  classifier: { confidence: number; detectedFields: string[] };
  requestId?: string;
}

const IMPORT_UPLOAD_TIMEOUT_MS = 60_000;

export async function importUpload(
  client: ApiClient,
  body: ImportUploadRequest,
): Promise<ImportUploadResponse> {
  return client.request<ImportUploadResponse>("/api/ai/import/upload", {
    method: "POST",
    body,
    timeoutMs: IMPORT_UPLOAD_TIMEOUT_MS,
  });
}

export interface ImportUpdateRowRequest {
  sessionId: string;
  rowIndex: number;
  /** Cell values keyed by canonical field name. Server coerces + validates. */
  fields: Record<string, string | number | null>;
}

export interface ImportUpdateRowResponse {
  block: EditableImportPreviewBlock;
  updatedRowIndex: number;
  requestId?: string;
}

const IMPORT_UPDATE_ROW_TIMEOUT_MS = 15_000;

/** PATCH one row's canonical fields in an in-flight import session. The
 *  server merges the fields, re-runs adapter.validateAndResolve on JUST
 *  that row, recomputes the session counts, and returns a fresh
 *  EditableImportPreviewBlock reflecting the new state. */
export async function importUpdateRow(
  client: ApiClient,
  body: ImportUpdateRowRequest,
): Promise<ImportUpdateRowResponse> {
  return client.request<ImportUpdateRowResponse>("/api/ai/import/update-row", {
    method: "POST",
    body,
    timeoutMs: IMPORT_UPDATE_ROW_TIMEOUT_MS,
  });
}

/* ───────────────────────────── Voice transcription ──────────────────────── */

/**
 * Send a recorded audio clip to the server, get a plain-text transcript back.
 *
 * Voice is purely an INPUT MODALITY. The resulting transcript is handed
 * straight to the normal chat composer; there is NO business-specific logic
 * in this round-trip. The Agent handles the transcript the same way it
 * handles typed text — same tools, same permissions, same confirmations.
 */
export interface TranscribeRequest {
  /** Base64-encoded audio bytes (NOT a data URL — raw base64). */
  audioBase64: string;
  /** Container mime type — `audio/m4a`, `audio/mp4` (iOS AAC), `audio/mpeg`,
   *  `audio/wav`, `audio/webm`, `audio/ogg`, `audio/aac`, `audio/flac`. */
  mimeType: string;
  /** Client-measured duration in ms (optional, used only for server-side telemetry). */
  durationMs?: number;
  /** Prefer "ar" (default) so Egyptian Arabic stays Egyptian Arabic. */
  languageHint?: "ar" | "en";
}

export interface TranscribeResponse {
  /** The transcript in the speaker's own language — no translation, no cleanup. */
  text: string;
  /** Model id that produced the transcript (telemetry). */
  model: string;
  /** Bytes the server actually consumed. */
  audioBytes: number;
  /** Echo of the client-supplied durationMs. */
  durationMs: number | null;
  requestId?: string;
}

/** Transcribe timeout is generous — Gemini audio can take ~3–8s for short
 *  clips; a bad network connection shouldn't surface as a vague failure. */
const TRANSCRIBE_TIMEOUT_MS = 45_000;

export async function transcribe(
  client: ApiClient,
  body: TranscribeRequest,
): Promise<TranscribeResponse> {
  return client.request<TranscribeResponse>("/api/ai/transcribe", {
    method: "POST",
    body,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
  });
}
