/**
 * Structured response types the AI agent returns to the mobile UI.
 *
 * Mirrored exactly in `packages/api-client/src/endpoints/ai.ts` so both ends
 * share the contract. Keep in sync — if you add a block kind here, add it
 * there (and in the mobile block renderer dispatcher) in the same change.
 */

/** F7 — supported AI response languages. Shop-owner default is Arabic; the
 *  agent locks per turn based on the user's latest message. Adding a new
 *  locale requires: (1) adding it here, (2) adding keyword/accent rules in
 *  lib/ai/language.ts, (3) adding dictionary entries in lib/ai/i18n.ts. */
export type Locale = "ar" | "en" | "pt" | "fr" | "es";

export type ChartKind = "line" | "bar" | "pie" | "donut" | "area";

export interface ChartSeries {
  dataKey: string;
  label: string;
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
  xKey?: string;
  series: ChartSeries[];
  data: Record<string, string | number>[];
  currency?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "start" | "end" | "center";
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
  token: string;
  expiresAt: string;
}

/**
 * ProductCardBlock — grounded product UI. Emitted by the agent AFTER a
 * search_products or get_product tool call so every field in this block is
 * backed by a database row (F-plan §15). Never synthesised by the model.
 */
export interface ProductCardBlock {
  kind: "product_card";
  productId: string;
  name: string;
  brand: string | null;
  sku: string | null;
  /** Currency-formatted price string. Backend formats, mobile displays. */
  price: number;
  currency: string;
  quantity: number;
  /** "in_stock" | "low_stock" | "out_of_stock" — renderer colours the chip. */
  stockState: "in_stock" | "low_stock" | "out_of_stock";
  imageUrl?: string | null;
  /** Optional caption below (e.g. "Matched on SKU"). */
  caption?: string;
}

/* ───────────────────────────── F4 blocks ─────────────────────────────── */

/**
 * ClarificationBlock — "which one did you mean?" picker.
 *
 * Each option carries the REAL entity id (uuid) from a prior tool call. The
 * mobile UI renders the option list as tappable chips/rows; tapping an option
 * sends `followUpText` back as a NEW user turn — so the follow-up flows into
 * F6 context resolution exactly like typing it would. The agent then proceeds
 * via preview_* / search_products as normal — the clarification never
 * short-circuits F5's preview → confirm pipeline.
 *
 * Grounding: `entityId` MUST appear in the turn's tool-result index or the
 * option is dropped (enforceGrounding).
 */
export interface ClarificationOption {
  entityId: string;
  /** User-visible label, in the LOCKED locale (e.g. "Pink Diva — 2200 EGP"). */
  label: string;
  /** Optional secondary line ("SKU AS-002 · in stock"). */
  hint?: string;
  /** The text the mobile app sends back as a user turn when tapped.
   *  Localised by the agent so "its price" / "سعره" resolves correctly. */
  followUpText: string;
}

export interface ClarificationBlock {
  kind: "clarification";
  /** Short headline ("Which product did you mean?"). */
  title: string;
  /** Optional one-line prompt under the title. */
  prompt?: string;
  options: ClarificationOption[];
  /** What kind of entity the options represent — used for layout + icon. */
  entityType: "product" | "customer" | "employee" | "generic";
}

/**
 * ComparisonBlock — side-by-side comparison of 2–4 entities (usually products).
 *
 * Deterministically built from tool results — the agent names the entities to
 * compare and the attributes to surface, but the server composes the final
 * block from grounded tool data. See `buildProductComparison`.
 */
export interface ComparisonAttribute {
  /** Row header, in the locked locale ("Price", "Stock", "Brand"). */
  label: string;
  /** Rendering hint — same taxonomy as TableColumn.format. */
  format?: "money" | "number" | "text" | "percent";
  /** Optional winner highlight: which entityId is the "best" for this attribute.
   *  When provided, the renderer accents that cell. Server picks the winner
   *  deterministically (e.g. cheapest for price, highest for quantity). */
  winnerEntityId?: string | null;
}

export interface ComparisonEntity {
  entityId: string;
  label: string;
  /** Optional short caption under the label ("Brand · SKU"). */
  subtitle?: string;
}

export interface ComparisonBlock {
  kind: "comparison";
  title: string;
  description?: string;
  entityType: "product" | "customer" | "employee" | "generic";
  entities: ComparisonEntity[];
  attributes: ComparisonAttribute[];
  /** Matrix keyed first by attribute.label, then by entityId → cell value.
   *  Empty string / null → render as "—" (unavailable), never estimated. */
  values: Record<string, Record<string, string | number | null>>;
  currency?: string;
}

/** InventorySummaryBlock — deterministic headline: total items, low-stock,
 *  out-of-stock, total stock value. Built server-side from the same repo
 *  helpers the mobile insights screen uses; never computed by the LLM. */
export interface InventorySummaryBlock {
  kind: "inventory_summary";
  title: string;
  /** Optional scope line ("الفرع: الحناوي ستورز" / "All branches"). */
  scope?: string;
  totalProducts: number;
  lowStockCount: number;
  outOfStockCount: number;
  /** Total stock value at cost or retail (server decides, labels the choice). */
  stockValue?: number;
  stockValueBasis?: "cost" | "retail";
  currency: string;
  /** Optional sample list — up to 3 low/out-of-stock items for context. Each
   *  row carries productId (grounded) so tapping routes the user to the item. */
  highlights?: Array<{ productId: string; name: string; quantity: number; state: "low_stock" | "out_of_stock" }>;
}

/** SalesSummaryBlock — deterministic headline for a period: revenue, orders,
 *  AOV, and optional prior-period trend. Server computes arithmetic; LLM only
 *  picks the period + asks for the block. */
export interface SalesSummaryBlock {
  kind: "sales_summary";
  title: string;
  /** "Today" / "Last 7 days" / "This month" — localised. */
  periodLabel: string;
  scope?: string;
  revenue: number;
  orders: number;
  averageOrderValue: number;
  currency: string;
  /** -N / +N as a decimal fraction (0.12 = +12%). null → prior period unknown. */
  revenueTrendPct?: number | null;
  ordersTrendPct?: number | null;
  /** Single top brand / top product line, optional. */
  topLine?: { label: string; value: string };
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

/** Summary + sample rows before the user confirms an import. */
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
  /** Representative samples — not the full list. */
  sampleCreate: ImportPreviewRowSummary[];
  sampleUpdate: ImportPreviewRowSummary[];
  sampleIssues: Array<{ rowIndex: number; status: string; issue: string }>;
  title: string;
  description: string;
}

/** Column metadata for the full editable import preview. */
export type EditableImportFieldType = "text" | "number" | "integer" | "money" | "choice";

export interface EditableImportColumn {
  /** Canonical field name (matches adapter.canonicalFields). */
  key: string;
  /** Localised header shown to the user. */
  label: string;
  type: EditableImportFieldType;
  /** False for server-computed fields (row status, existing values). */
  editable: boolean;
  /** Fields required for create (shown with a marker). */
  required: boolean;
  /** For type==="choice" — allowed values the picker shows. */
  choices?: string[];
  /** Hint for the renderer — minimum column width in dip. */
  minWidth?: number;
}

/** One row in the editable preview. Carries the server-assigned ai_import_rows.id
 *  so inline edits PATCH the exact row on the server. */
export interface EditableImportRow {
  rowIndex: number;
  rowId: string;
  status: "valid" | "invalid" | "ambiguous" | "missing" | "ready" | "imported" | "failed" | "skipped";
  action: "create" | "update" | "skip" | "none";
  /** Cell values keyed by column.key. Server coerces strings → types on PATCH. */
  cells: Record<string, string | number | null>;
  /** When action="update", the existing DB values the update will overwrite. */
  existing?: Record<string, string | number | null>;
  /** First row error / issue shown as a chip. */
  issue?: string;
  /** All errors + issues as a flat list. */
  errors: string[];
}

/**
 * EditableImportPreviewBlock — the full, interactive import workspace.
 *
 * Unlike ImportPreviewBlock, this one includes EVERY row + column so the
 * mobile client can render a scrollable table the user can inspect and
 * edit before confirming. Row edits PATCH /api/ai/import/update-row which
 * re-runs adapter.validateAndResolve and returns the fresh row + counts.
 */
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
  /** True when the session has no outstanding issues and can be confirmed. */
  readyToConfirm: boolean;
  /** ISO timestamp of when the server computed this preview. */
  computedAt: string;
  currency?: string;
}

/** User-facing question when the engine needs input to proceed. */
export interface ImportQuestionBlock {
  kind: "import_question";
  sessionId: string;
  title: string;
  /** The specific question + the structured correction it maps to. */
  questions: Array<{
    kind: "missing_field" | "ambiguous_field" | "action_for_row" | "other";
    message: string;
    affectedRows: number[];
    field?: string;
    suggestedActions?: string[];
  }>;
}

/** Final result after the import executed. */
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

/** Signalled when rollback of the import group hits a conflict. */
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

/**
 * RollbackPreviewBlock — summary of a pending rollback. Shipped alongside a
 * ConfirmationBlock so the user sees the full before/after + metadata, then
 * taps Confirm to execute.
 */
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
  /** Locale-aware strings assembled server-side so mobile need only render. */
  title: string;
  description: string;
}

/** RollbackResultBlock — emitted by the executor after a successful rollback. */
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

/**
 * RollbackConflictBlock — emitted when rollback is blocked. `kind_detail`
 * is a stable enum so the mobile client + telemetry can bucket.
 */
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

/* ─────────────────────────── F9 — knowledge ─────────────────────────── */

export interface KnowledgeSource {
  documentId: string;
  chunkId: string;
  title: string;
  version: number;
  section: string | null;
  /** The confidence tier for this citation (HIGH/MEDIUM/LOW). Never NONE —
   *  NONE-tier citations are stripped at grounding time. */
  tier: "HIGH" | "MEDIUM" | "LOW";
}

/**
 * KnowledgeAnswerBlock — grounded answer to a documents/policy question.
 *
 * `answer` is the LLM-generated prose. `sources` are the server-grounded
 * citations: every entry corresponds to a real chunk returned by
 * search_knowledge in the same turn. The F9 grounding guard DROPS any
 * citation whose chunkId wasn't retrieved — the LLM cannot fabricate a
 * citation that will reach the mobile client.
 */
export interface KnowledgeAnswerBlock {
  kind: "knowledge_answer";
  answer: string;
  sources: KnowledgeSource[];
}

/** WarningBlock — surfaces operational / data-quality / safety notices to the
 *  user. Used by:
 *   • F5.1 audit-failure path ("write succeeded but audit didn't log")
 *   • Partial-data situations ("sales tax isn't recorded, revenue excludes it")
 *   • Permission downgrades, stale references, etc.
 *  Every warning carries a stable `code` so client-side telemetry can bucket. */
export interface WarningBlock {
  kind: "warning";
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  /** Stable machine-readable code (SNAKE_CASE), e.g. "AUDIT_WRITE_FAILED",
   *  "METRIC_UNAVAILABLE", "STALE_REFERENCE". Never shown to the user — used
   *  by the mobile client for telemetry + optional recovery actions. */
  code: string;
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

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentResponse {
  blocks: AiBlock[];
  locale: Locale;
  model: string;
  usage: AgentUsage;
  toolsCalled: string[];
  /** F11 — stable logical id for the entire assistant turn.
   *
   * The server mints one UUID per `runAgent` call and threads it through
   * every internal event (tool calls, agent rounds, retries, fallbacks)
   * belonging to this turn. Mobile uses it as the AssistantMessage id so
   * duplicate deliveries (future streaming, future retries, double-fires
   * from any source) target the same stable identity and never visually
   * duplicate. Optional for backwards compatibility — callers that don't
   * provide it fall back to a client-generated uuid. */
  turnId?: string;
}
