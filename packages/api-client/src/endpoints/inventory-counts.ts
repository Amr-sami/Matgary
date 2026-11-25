// Inventory Count (جرد) — thin wrappers over apps/web/app/api/inventory-counts/*.
// Tenant-isolated (no branch concept). The confirm endpoint honours an
// Idempotency-Key header so a replayed confirm returns the stored result.

import { ApiError } from "../errors";
import type { ApiClient } from "../http";

export type CountScopeKind = "all" | "category" | "brand";
export type CountStatus = "draft" | "in_progress" | "review" | "completed" | "cancelled";
export type CountLineSource = "scan" | "manual";

export interface CountScope {
  kind: CountScopeKind;
  value: string | null;
}

export interface Count {
  id: string;
  tenantId: string;
  scopeKind: CountScopeKind;
  scopeValue: string | null;
  status: CountStatus;
  scopeProductCount: number;
  createdByUserId: string;
  createdAt: string;
  confirmedAt: string | null;
  confirmedByUserId: string | null;
  confirmIdempotencyKey: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
}

export interface CountSummary {
  scopeProductCount: number;
  linesCounted: number;
  linesMatched: number;
  linesShortage: number;
  linesOverage: number;
  addedMidCount: number;
  netAdjustment: number;
}

export interface CountListItem {
  count: Count;
  summary: CountSummary;
}

export interface CountLine {
  id: string;
  countId: string;
  tenantId: string;
  productId: string;
  baselineQty: number;
  countedQty: number | null;
  countedAt: string | null;
  countedByUserId: string | null;
  source: CountLineSource | null;
  addedMidCount: boolean;
  productMissingAtConfirm: boolean;
  createdAt: string;
  // Enriched from products table (left join) — null when product was deleted.
  productName: string | null;
  productSku: string | null;
  categoryId: string | null;
  brand: string | null;
  productCurrentQty: number | null;
  productDeleted: boolean;
}

export interface Reconciliation {
  id: string;
  tenantId: string;
  countId: string;
  productId: string;
  baselineQty: number;
  countedQty: number;
  countedAt: string;
  movementAfterCount: number;
  currentQtyAtConfirm: number;
  expectedPhysical: number;
  adjustment: number;
  productHistoryId: string | null;
  createdAt: string;
}

export interface ConfirmResult {
  countId: string;
  confirmedAt: string;
  reconciliations: Reconciliation[];
  appliedAdjustments: number;
}

export interface OutOfScopeDetails {
  productId: string;
  currentQty: number;
}

export interface InvalidLinesDetails {
  invalidProductIds: string[];
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listCounts(
  c: ApiClient,
  opts: { status?: CountStatus | "active" } = {},
): Promise<CountListItem[]> {
  const res = await c.request<{ data: CountListItem[] }>("/api/inventory-counts", {
    query: opts.status ? { status: opts.status } : undefined,
  });
  return res.data ?? [];
}

export async function getCount(
  c: ApiClient,
  countId: string,
): Promise<{ count: Count; summary: CountSummary; lines: CountLine[] }> {
  return c.request(`/api/inventory-counts/${encodeURIComponent(countId)}`);
}

// ─── Create / cancel ─────────────────────────────────────────────────────────

export async function createCount(
  c: ApiClient,
  input: { scope: CountScope },
): Promise<{ id: string; countId: string; scopeProductCount: number }> {
  const res = await c.request<{ countId: string; scopeProductCount: number }>(
    "/api/inventory-counts",
    { method: "POST", body: input },
  );
  return { ...res, id: res.countId };
}

export async function cancelCount(c: ApiClient, countId: string): Promise<{ ok: true }> {
  return c.request<{ ok: true }>(
    `/api/inventory-counts/${encodeURIComponent(countId)}/cancel`,
    { method: "POST" },
  );
}

// ─── Lines ───────────────────────────────────────────────────────────────────

export interface UpsertLineInput {
  countedQty: number;
  source: CountLineSource;
  /** True after an owner confirms "add anyway" on an out-of-scope product. */
  force?: boolean;
}

export async function upsertLine(
  c: ApiClient,
  countId: string,
  productId: string,
  input: UpsertLineInput,
): Promise<{ line: CountLine }> {
  return c.request<{ line: CountLine }>(
    `/api/inventory-counts/${encodeURIComponent(countId)}/lines/${encodeURIComponent(productId)}`,
    { method: "PUT", body: input },
  );
}

export async function deleteLine(
  c: ApiClient,
  countId: string,
  productId: string,
): Promise<{ ok: true }> {
  return c.request<{ ok: true }>(
    `/api/inventory-counts/${encodeURIComponent(countId)}/lines/${encodeURIComponent(productId)}`,
    { method: "DELETE" },
  );
}

/** Pull `OUT_OF_SCOPE` detail from the api error so the client can offer the
 *  "Add anyway?" prompt without string-matching. */
export function outOfScopeDetailsOf(err: unknown): OutOfScopeDetails | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== "OUT_OF_SCOPE") return null;
  const body = err.body as { details?: OutOfScopeDetails } | null;
  return body?.details ?? null;
}

/** Pull `COUNT_HAS_INVALID_LINES` detail so the exceptions screen can list
 *  the specific products that need resolving. */
export function invalidLinesDetailsOf(err: unknown): InvalidLinesDetails | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== "COUNT_HAS_INVALID_LINES") return null;
  const body = err.body as { details?: InvalidLinesDetails } | null;
  return body?.details ?? null;
}

// ─── Confirm ─────────────────────────────────────────────────────────────────

export async function confirmCount(
  c: ApiClient,
  countId: string,
  opts: { idempotencyKey?: string } = {},
): Promise<ConfirmResult> {
  const key = opts.idempotencyKey ?? `count-${countId}-confirm`;
  return c.request<ConfirmResult>(
    `/api/inventory-counts/${encodeURIComponent(countId)}/confirm`,
    { method: "POST", headers: { "Idempotency-Key": key } },
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface CountReportHeader {
  countId: string;
  ref: string;
  status: CountStatus;
  scope: CountScope;
  scopeLabel: string;
  createdAt: string;
  createdByName: string | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  scopeProductCount: number;
}

export interface CountReportSummary {
  linesTotal: number;
  linesMatched: number;
  linesShortage: number;
  linesOverage: number;
  addedMidCount: number;
  netAdjustment: number;
  financialImpact: number | null;
}

export interface CountReportLine {
  productId: string;
  productName: string;
  productSku: string | null;
  brand: string | null;
  categoryId: string | null;
  baselineQty: number;
  countedQty: number;
  countedAt: string;
  movementAfterCount: number;
  currentQtyAtConfirm: number;
  expectedPhysical: number;
  adjustment: number;
  valueImpact: number | null;
  addedMidCount: boolean;
}

export interface CountReport {
  header: CountReportHeader;
  summary: CountReportSummary;
  lines: CountReportLine[];
}

export async function getCountReport(
  c: ApiClient,
  countId: string,
): Promise<CountReport> {
  return c.request<CountReport>(
    `/api/inventory-counts/${encodeURIComponent(countId)}/report`,
  );
}

/** URL for the binary PDF — caller fetches with its own HTTP (mobile uses
 *  expo-file-system so it can save to a tmp file and open the share sheet). */
export function reportPdfPath(countId: string): string {
  return `/api/inventory-counts/${encodeURIComponent(countId)}/report.pdf`;
}
