// Digital collections — the L1 ledger (05 §4.5–§4.13, §4.21; 03 §B.2.2, §C).
//
// One `collections` row per expected transfer ("part"): written `pending` in
// the same transaction as the sale / settlement that created it, then
// confirmed or rejected by someone holding `confirm_collections` (never the
// person who recorded it, owners exempt), reopened by the owner within 7 days.
// `sales.collection_status` is the invoice-level mirror, written on EVERY line
// (`reconcileInvoiceCollectionStatus`). `collection_events` is append-only.
//
// House rules kept here:
//   - money is compared in integer piasters (math.ts); columns are numeric;
//   - raw `sql` binds timestamps as `now()` or ISO text, never a JS Date
//     (the pinned gotcha, customers.ts:254-262);
//   - lock order: an invoice's collection parts (part_no order) BEFORE its
//     sales lines (id order); a settlement locks its row, then its
//     sale_payments rows, then their lines (05 §4.9). 07 takes its
//     per-account advisory lock before calling any of this.

import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  collectionAccounts,
  collectionEvents,
  collections,
  shopSettings,
  type CollectionRow,
} from "@/lib/db/schema";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { bustInsightsCache } from "@/lib/repo/insights";
import { resolvePartAccounts } from "@/lib/repo/collection-accounts";
import {
  EMPTY_EFFECTS,
  releaseCredits,
  reverseMatch,
  type MatchEffects,
} from "@/lib/repo/collection-matching";
import type { TenantTx } from "@/lib/collections/flags";
import {
  allocateRejection,
  deriveInvoiceStatus,
  fromPiasters,
  normaliseParts,
  roundToPiasters,
  type CollectionPartInput,
} from "@/lib/collections/math";
import { accountMask } from "@matgary/domain/collections/normalize";
import { limitWarnings } from "@matgary/domain/collections/limits";
import type {
  CollectionEventKind,
  CollectionFlag,
  CollectionProvider,
  CollectionRail,
  CollectionSourceType,
  CollectionStatus,
  DigitalMethod,
  LimitWarning,
  RejectOutcome,
  RejectReason,
  SaleCollectionStatus,
} from "@matgary/domain/collections/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (03 §C.8 REOPEN_DAYS; 05 §4.4, §4.6, §4.13)
// ─────────────────────────────────────────────────────────────────────────────

export const REOPEN_DAYS = 7;
/** A decision retried after Redis lost the idempotency entry answers 200
 *  with the current DTO within this window (05 §4.4 durable fallback). */
export const DECISION_REPLAY_HOURS = 24;
export const NOTE_MAX_LENGTH = 280;
/** `customDate` this much before the insert → flag `offline_rung`. */
export const OFFLINE_RUNG_MS = 5 * 60_000;
export const COLLECTIONS_PAGE_MAX = 100;
export const COLLECTIONS_PAGE_DEFAULT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes (03 §B.17, 05 §4.13)
// ─────────────────────────────────────────────────────────────────────────────

/** Defined by 05, filled by 07 from M2; always null in M1. */
export interface CreditSummary {
  id: string;
  amount: number;
  occurredAt: string;
  channels: string[];
  templateId: string;
  payerNameMasked: string | null;
  operatorReference: string | null;
}

export interface CollectionAccountRef {
  id: string;
  label: string;
  provider: CollectionProvider;
  rail: CollectionRail;
  mask: string;
}

export interface CollectionDTO {
  id: string;
  status: CollectionStatus;
  sourceType: CollectionSourceType;
  method: DigitalMethod;
  amount: number;
  partNo: number;
  partsCount: number;
  invoiceId: string | null;
  anchorSaleId: string | null;
  branchId: string;
  account: CollectionAccountRef | null;
  payerPhoneLast4: string | null;
  payerReference: string | null;
  rungAt: string;
  recordedBy: { id: string; name: string | null } | null;
  decidedBy: { id: string; name: string | null } | null;
  decidedAt: string | null;
  rejectReason: RejectReason | null;
  rejectOutcome: RejectOutcome | null;
  flags: CollectionFlag[];
  isStale: boolean;
  matchedCredit: CreditSummary | null;
  customerPhone: string | null;
}

export interface CollectionEventDTO {
  kind: CollectionEventKind;
  fromStatus: CollectionStatus | null;
  toStatus: CollectionStatus | null;
  actor: { id: string; name: string | null } | null;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface CollectionDetailDTO extends CollectionDTO {
  events: CollectionEventDTO[];
}

export interface CollectionsPage {
  data: CollectionDTO[];
  nextCursor: string | null;
  counts: { pending: number; stale: number };
}

export interface SummaryBucket {
  count: number;
  amount: number;
}

export interface SummaryAccountRow {
  /** null = the "no account" row. */
  accountId: string | null;
  label: string | null;
  provider: CollectionProvider | null;
  rail: CollectionRail | null;
  confirmed: SummaryBucket;
  autoConfirmed: SummaryBucket;
  pending: SummaryBucket;
  rejectedDebt: SummaryBucket;
  rejectedLoss: SummaryBucket;
  /** {0,0} in M1; 07 fills it. */
  unmatchedCredits: SummaryBucket;
  limitWarnings: LimitWarning[];
}

export interface CollectionsSummary {
  date: string;
  branchId: string | null;
  accounts: SummaryAccountRow[];
  totals: {
    confirmed: SummaryBucket;
    autoConfirmed: SummaryBucket;
    pending: SummaryBucket;
    rejectedDebt: SummaryBucket;
    rejectedLoss: SummaryBucket;
    unmatchedCredits: SummaryBucket;
    /** Σ over the day's digital invoices of max(0, invoice total − Σ non-void parts). */
    cashRemainder: number;
  };
}

export interface CollectionSettingsDTO {
  branchId: string;
  collectionsEnabled: boolean;
  collectionsRequireAccount: boolean;
  collectionsStaleAfterMinutes: number;
  collectionsAutoConfirmEnabled: boolean;
  collectionsStorePayerNames: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function rows<T>(res: unknown): T[] {
  return res as T[];
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

/** `IN (…)` for raw SQL (drizzle expands a bare array param as a row). */
function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

function pt(v: string | number | null | undefined): number {
  return v == null ? 0 : roundToPiasters(v);
}

function egp(v: string | number | null | undefined): number {
  return pt(v) / 100;
}

/** Stale when pending past the branch's threshold (default 120 min, Q15). */
const STALE_EXPR = sql`(c.status = 'pending' AND c.rung_at < now() - make_interval(mins => COALESCE(ss.collections_stale_after_minutes, 120)))`;

// ─────────────────────────────────────────────────────────────────────────────
// DTO read
// ─────────────────────────────────────────────────────────────────────────────

interface DtoRow {
  id: string;
  status: string;
  source_type: string;
  method: string;
  amount: string;
  part_no: number;
  invoice_id: string | null;
  anchor_sale_id: string | null;
  branch_id: string;
  collection_account_id: string | null;
  account_label: string | null;
  account_provider: string | null;
  account_rail: string | null;
  account_last4: string | null;
  wallet_msisdn: string | null;
  ipa_handle: string | null;
  is_prepaid_card: boolean | null;
  payer_phone_last4: string | null;
  payer_reference: string | null;
  rung_at: string;
  rung_at_key: string;
  recorded_by_user_id: string | null;
  recorded_by_name: string | null;
  decided_by_user_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  reject_outcome: string | null;
  flags: string[] | null;
  matched_credit_id: string | null;
  customer_phone: string | null;
  is_stale: boolean;
  parts_count: number;
}

function dtoQuery(tenantId: string, where: SQL, tail: SQL = sql``): SQL {
  return sql`
    SELECT c.id, c.status, c.source_type, c.method, c.amount::text AS amount, c.part_no,
           c.invoice_id, c.anchor_sale_id, c.branch_id, c.collection_account_id,
           a.label AS account_label, a.provider AS account_provider, a.rail AS account_rail,
           a.account_last4, a.wallet_msisdn, a.ipa_handle, a.is_prepaid_card,
           c.payer_phone_last4, c.payer_reference,
           c.rung_at, to_json(c.rung_at) #>> '{}' AS rung_at_key,
           c.recorded_by_user_id, ru.name AS recorded_by_name,
           c.decided_by_user_id, du.name AS decided_by_name, c.decided_at,
           c.reject_reason, c.reject_outcome, c.flags, c.matched_credit_id, c.customer_phone,
           ${STALE_EXPR} AS is_stale,
           CASE WHEN c.source_type = 'sale' AND c.invoice_id IS NOT NULL THEN
             (SELECT count(*)::int FROM collections c2
               WHERE c2.tenant_id = c.tenant_id AND c2.source_type = 'sale' AND c2.invoice_id = c.invoice_id)
           ELSE 1 END AS parts_count
      FROM collections c
      LEFT JOIN collection_accounts a ON a.tenant_id = c.tenant_id AND a.id = c.collection_account_id
      LEFT JOIN users ru ON ru.id = c.recorded_by_user_id
      LEFT JOIN users du ON du.id = c.decided_by_user_id
      LEFT JOIN shop_settings ss ON ss.tenant_id = c.tenant_id AND ss.branch_id = c.branch_id
     WHERE c.tenant_id = ${tenantId} AND ${where}
     ${tail}`;
}

/** The joined row → the 03 §B.17 CollectionDTO. `account.mask` is 06's
 *  ASCII accountMask() of the account row (05 ARCH CR 9). */
export function toCollectionDTO(r: DtoRow): CollectionDTO {
  return {
    id: r.id,
    status: r.status as CollectionStatus,
    sourceType: r.source_type as CollectionSourceType,
    method: r.method as DigitalMethod,
    amount: egp(r.amount),
    partNo: Number(r.part_no),
    partsCount: Number(r.parts_count ?? 1),
    invoiceId: r.invoice_id,
    anchorSaleId: r.anchor_sale_id,
    branchId: r.branch_id,
    account:
      r.collection_account_id && r.account_label != null
        ? {
            id: r.collection_account_id,
            label: r.account_label,
            provider: r.account_provider as CollectionProvider,
            rail: r.account_rail as CollectionRail,
            mask: accountMask({
              accountLast4: r.account_last4,
              walletMsisdn: r.wallet_msisdn,
              ipaHandle: r.ipa_handle,
              isPrepaidCard: r.is_prepaid_card,
            }),
          }
        : null,
    payerPhoneLast4: r.payer_phone_last4,
    payerReference: r.payer_reference,
    rungAt: toIso(r.rung_at)!,
    recordedBy: r.recorded_by_user_id ? { id: r.recorded_by_user_id, name: r.recorded_by_name } : null,
    decidedBy: r.decided_by_user_id ? { id: r.decided_by_user_id, name: r.decided_by_name } : null,
    decidedAt: toIso(r.decided_at),
    rejectReason: (r.reject_reason as RejectReason | null) ?? null,
    rejectOutcome: (r.reject_outcome as RejectOutcome | null) ?? null,
    flags: (r.flags ?? []) as CollectionFlag[],
    isStale: !!r.is_stale,
    matchedCredit: null,
    customerPhone: r.customer_phone,
  };
}

async function readDto(tx: TenantTx, tenantId: string, id: string): Promise<CollectionDTO | null> {
  const r = rows<DtoRow>(await tx.execute(dtoQuery(tenantId, sql`c.id = ${id}`)));
  return r[0] ? toCollectionDTO(r[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// List (GET collections) — keyset on (rung_at, id)
// ─────────────────────────────────────────────────────────────────────────────

export function encodeCollectionCursor(rungAtKey: string, id: string): string {
  return Buffer.from(`${rungAtKey}|${id}`, "utf8").toString("base64url");
}

export function decodeCollectionCursor(raw: string): { rungAt: string; id: string } {
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new DomainError("INVALID_CURSOR", 400);
  }
  const i = text.lastIndexOf("|");
  const rungAt = i > 0 ? text.slice(0, i) : "";
  const id = i > 0 ? text.slice(i + 1) : "";
  if (
    !rungAt ||
    Number.isNaN(new Date(rungAt).getTime()) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new DomainError("INVALID_CURSOR", 400);
  }
  return { rungAt, id };
}

export interface ListCollectionsInput {
  statuses?: CollectionStatus[];
  accountId?: string;
  sourceType?: CollectionSourceType;
  /** null = every branch (owner `branchId=all`). */
  branchId: string | null;
  from?: string;
  to?: string;
  stale?: boolean;
  invoiceId?: string;
  order?: "asc" | "desc";
  cursor?: string | null;
  limit?: number;
  /** A caller with record_sales but not view_collections sees only their own rows. */
  recordedByUserId?: string;
}

export async function listCollections(tenantId: string, input: ListCollectionsInput): Promise<CollectionsPage> {
  const limit = Math.max(1, Math.min(COLLECTIONS_PAGE_MAX, input.limit ?? COLLECTIONS_PAGE_DEFAULT));
  const order = input.order === "asc" ? "asc" : "desc";
  const cursor = input.cursor ? decodeCollectionCursor(input.cursor) : null;

  // Scope = branch + recorder: shared by the page and the badge counts.
  const scope: SQL[] = [];
  if (input.branchId) scope.push(sql`c.branch_id = ${input.branchId}`);
  if (input.recordedByUserId) scope.push(sql`c.recorded_by_user_id = ${input.recordedByUserId}`);

  const filters: SQL[] = [...scope];
  if (input.statuses && input.statuses.length > 0) filters.push(sql`c.status IN (${inList(input.statuses)})`);
  if (input.accountId) filters.push(sql`c.collection_account_id = ${input.accountId}`);
  if (input.sourceType) filters.push(sql`c.source_type = ${input.sourceType}`);
  if (input.from) filters.push(sql`c.rung_at >= ${input.from}::timestamptz`);
  if (input.to) filters.push(sql`c.rung_at <= ${input.to}::timestamptz`);
  if (input.stale) filters.push(STALE_EXPR);
  if (input.invoiceId) filters.push(sql`c.invoice_id = ${input.invoiceId}`);
  if (cursor) {
    filters.push(
      order === "desc"
        ? sql`(c.rung_at, c.id) < (${cursor.rungAt}::timestamptz, ${cursor.id}::uuid)`
        : sql`(c.rung_at, c.id) > (${cursor.rungAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const where = filters.length > 0 ? sql.join(filters, sql` AND `) : sql`true`;
  const tail =
    order === "desc"
      ? sql`ORDER BY c.rung_at DESC, c.id DESC LIMIT ${limit + 1}`
      : sql`ORDER BY c.rung_at ASC, c.id ASC LIMIT ${limit + 1}`;

  return withTenant(tenantId, async (tx) => {
    const list = rows<DtoRow>(await tx.execute(dtoQuery(tenantId, where, tail)));
    const hasMore = list.length > limit;
    const page = hasMore ? list.slice(0, limit) : list;
    const last = page[page.length - 1];
    const scopeWhere = scope.length > 0 ? sql.join(scope, sql` AND `) : sql`true`;
    const [counts] = rows<{ pending: number; stale: number }>(
      await tx.execute(sql`
        SELECT count(*) FILTER (WHERE c.status = 'pending')::int AS pending,
               count(*) FILTER (WHERE ${STALE_EXPR})::int AS stale
          FROM collections c
          LEFT JOIN shop_settings ss ON ss.tenant_id = c.tenant_id AND ss.branch_id = c.branch_id
         WHERE c.tenant_id = ${tenantId} AND c.status = 'pending' AND ${scopeWhere}
      `),
    );
    return {
      data: page.map(toCollectionDTO),
      nextCursor: hasMore && last ? encodeCollectionCursor(last.rung_at_key, last.id) : null,
      counts: { pending: Number(counts?.pending ?? 0), stale: Number(counts?.stale ?? 0) },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail (GET collections/[id])
// ─────────────────────────────────────────────────────────────────────────────

export interface CollectionAccess {
  /** null = every branch (owner). */
  accessibleBranchIds: string[] | null;
}

function branchReachable(branchId: string, access: CollectionAccess): boolean {
  return access.accessibleBranchIds === null || access.accessibleBranchIds.includes(branchId);
}

export async function getCollection(
  tenantId: string,
  id: string,
  opts: CollectionAccess & { includeSnapshots: boolean },
): Promise<CollectionDetailDTO | null> {
  return withTenant(tenantId, async (tx) => {
    const dto = await readDto(tx, tenantId, id);
    if (!dto || !branchReachable(dto.branchId, opts)) return null;
    const ev = rows<{
      kind: string;
      from_status: string | null;
      to_status: string | null;
      actor_user_id: string | null;
      actor_name: string | null;
      created_at: string;
      details: Record<string, unknown> | null;
    }>(
      await tx.execute(sql`
        SELECT e.kind, e.from_status, e.to_status, e.actor_user_id, u.name AS actor_name,
               e.created_at, e.details
          FROM collection_events e
          LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.tenant_id = ${tenantId} AND e.collection_id = ${id}
         ORDER BY e.created_at ASC, e.id ASC
      `),
    );
    const events: CollectionEventDTO[] = ev.map((e) => {
      const details = { ...(e.details ?? {}) };
      // Line snapshots (before/after amounts of the invoice lines) are the
      // owner's reopen input, not something every viewer needs (05 §4.13).
      if (!opts.includeSnapshots) {
        delete details.lines;
        delete details.livePaymentIds;
      }
      return {
        kind: e.kind as CollectionEventKind,
        fromStatus: (e.from_status as CollectionStatus | null) ?? null,
        toStatus: (e.to_status as CollectionStatus | null) ?? null,
        actor: e.actor_user_id ? { id: e.actor_user_id, name: e.actor_name } : null,
        createdAt: toIso(e.created_at)!,
        details,
      };
    });
    return { ...dto, events };
  });
}

/** Branch + recorder of one collection (the route's second-stage gate for
 *  cashiers). null when missing or out of reach (→ 404). */
export async function getCollectionHead(
  tenantId: string,
  id: string,
  access: CollectionAccess,
): Promise<{ branchId: string; recordedByUserId: string | null; status: CollectionStatus } | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ branchId: collections.branchId, recordedByUserId: collections.recordedByUserId, status: collections.status })
      .from(collections)
      .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)))
      .limit(1);
    if (!row || !branchReachable(row.branchId, access)) return null;
    return { ...row, status: row.status as CollectionStatus };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings (GET / PATCH collections/settings)
// ─────────────────────────────────────────────────────────────────────────────

export async function getCollectionSettingsRow(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
): Promise<CollectionSettingsDTO> {
  const [row] = await tx
    .select({
      collectionsEnabled: shopSettings.collectionsEnabled,
      collectionsRequireAccount: shopSettings.collectionsRequireAccount,
      collectionsStaleAfterMinutes: shopSettings.collectionsStaleAfterMinutes,
      collectionsAutoConfirmEnabled: shopSettings.collectionsAutoConfirmEnabled,
      collectionsStorePayerNames: shopSettings.collectionsStorePayerNames,
    })
    .from(shopSettings)
    .where(and(eq(shopSettings.tenantId, tenantId), eq(shopSettings.branchId, branchId)))
    .limit(1);
  // A missing row reads as the 0055 column defaults.
  return {
    branchId,
    collectionsEnabled: row?.collectionsEnabled ?? false,
    collectionsRequireAccount: row?.collectionsRequireAccount ?? true,
    collectionsStaleAfterMinutes: row?.collectionsStaleAfterMinutes ?? 120,
    collectionsAutoConfirmEnabled: row?.collectionsAutoConfirmEnabled ?? false,
    collectionsStorePayerNames: row?.collectionsStorePayerNames ?? false,
  };
}

export async function getCollectionSettings(tenantId: string, branchId: string): Promise<CollectionSettingsDTO> {
  return withTenant(tenantId, (tx) => getCollectionSettingsRow(tx, tenantId, branchId));
}

export type CollectionSettingsPatch = Partial<Omit<CollectionSettingsDTO, "branchId">>;

/** Insert-or-update of the five switches for (tenant, branch). */
export async function saveCollectionSettings(
  tenantId: string,
  branchId: string,
  patch: CollectionSettingsPatch,
): Promise<{ settings: CollectionSettingsDTO; changed: string[] }> {
  return withTenant(tenantId, async (tx) => {
    const before = await getCollectionSettingsRow(tx, tenantId, branchId);
    const set: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (before[k as keyof CollectionSettingsDTO] !== v) changed.push(k);
      set[k] = v;
    }
    if (Object.keys(set).length > 0) {
      await tx
        .insert(shopSettings)
        .values({ tenantId, branchId, ...set })
        .onConflictDoUpdate({
          target: [shopSettings.tenantId, shopSettings.branchId],
          set: { ...set, updatedAt: sql`now()` },
        });
    }
    return { settings: await getCollectionSettingsRow(tx, tenantId, branchId), changed };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary (GET collections/summary) — the digital "Z" per account per day
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = (): SummaryBucket => ({ count: 0, amount: 0 });

export async function getCollectionsSummary(
  tenantId: string,
  input: { date?: string | null; branchId: string | null },
): Promise<CollectionsSummary> {
  return withTenant(tenantId, async (tx) => {
    // Tenant-timezone day bounds, computed by Postgres (digest.ts:70-75).
    const [b] = rows<{ date: string; day_start: string; day_end: string; month_start: string }>(
      await tx.execute(sql`
        WITH t AS (SELECT COALESCE((SELECT timezone FROM tenants WHERE id = ${tenantId}), 'Africa/Cairo') AS tz),
             d AS (SELECT COALESCE(${input.date ?? null}::date, (now() AT TIME ZONE (SELECT tz FROM t))::date) AS day)
        SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
               (d.day::timestamp AT TIME ZONE t.tz) AS day_start,
               ((d.day + 1)::timestamp AT TIME ZONE t.tz) AS day_end,
               (date_trunc('month', d.day)::timestamp AT TIME ZONE t.tz) AS month_start
          FROM d, t
      `),
    );
    const dayStart = b!.day_start;
    const dayEnd = b!.day_end;
    const branchFilter = input.branchId ? sql`AND c.branch_id = ${input.branchId}` : sql``;

    const buckets = rows<{
      account_id: string | null;
      confirmed_n: number; confirmed_a: string;
      auto_n: number; auto_a: string;
      pending_n: number; pending_a: string;
      debt_n: number; debt_a: string;
      loss_n: number; loss_a: string;
    }>(
      await tx.execute(sql`
        SELECT c.collection_account_id AS account_id,
               count(*) FILTER (WHERE c.status = 'confirmed')::int AS confirmed_n,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'confirmed'), 0)::text AS confirmed_a,
               count(*) FILTER (WHERE c.status = 'auto_confirmed')::int AS auto_n,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'auto_confirmed'), 0)::text AS auto_a,
               count(*) FILTER (WHERE c.status = 'pending')::int AS pending_n,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'pending'), 0)::text AS pending_a,
               count(*) FILTER (WHERE c.status = 'rejected' AND c.reject_outcome = 'debt')::int AS debt_n,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'rejected' AND c.reject_outcome = 'debt'), 0)::text AS debt_a,
               count(*) FILTER (WHERE c.status = 'rejected' AND c.reject_outcome = 'loss')::int AS loss_n,
               COALESCE(sum(c.amount) FILTER (WHERE c.status = 'rejected' AND c.reject_outcome = 'loss'), 0)::text AS loss_a
          FROM collections c
         WHERE c.tenant_id = ${tenantId}
           AND c.status <> 'void'
           AND c.rung_at >= ${dayStart}::timestamptz AND c.rung_at < ${dayEnd}::timestamptz
           ${branchFilter}
         GROUP BY c.collection_account_id
      `),
    );

    const accountIds = buckets.map((x) => x.account_id).filter((x): x is string => !!x);
    const accounts = accountIds.length
      ? await tx
          .select()
          .from(collectionAccounts)
          .where(and(eq(collectionAccounts.tenantId, tenantId), inArray(collectionAccounts.id, accountIds)))
      : [];
    const accountById = new Map(accounts.map((a) => [a.id, a] as const));

    // Limits are per wallet, whatever branch took the money: day and
    // month-to-date received (confirmed + auto + pending), tenant-wide.
    const walletIds = accounts.filter((a) => a.rail === "wallet").map((a) => a.id);
    const received = walletIds.length
      ? rows<{ account_id: string; day: string; month: string }>(
          await tx.execute(sql`
            SELECT c.collection_account_id AS account_id,
                   COALESCE(sum(c.amount) FILTER (WHERE c.rung_at >= ${dayStart}::timestamptz), 0)::text AS day,
                   COALESCE(sum(c.amount), 0)::text AS month
              FROM collections c
             WHERE c.tenant_id = ${tenantId}
               AND c.collection_account_id IN (${inList(walletIds)})
               AND c.status IN ('pending', 'confirmed', 'auto_confirmed')
               AND c.rung_at >= ${b!.month_start}::timestamptz AND c.rung_at < ${dayEnd}::timestamptz
             GROUP BY c.collection_account_id
          `),
        )
      : [];
    const receivedById = new Map(received.map((r) => [r.account_id, r] as const));

    const totals = {
      confirmed: ZERO(),
      autoConfirmed: ZERO(),
      pending: ZERO(),
      rejectedDebt: ZERO(),
      rejectedLoss: ZERO(),
      unmatchedCredits: ZERO(),
      cashRemainder: 0,
    };
    const add = (t: SummaryBucket, n: number, a: string) => {
      t.count += Number(n);
      t.amount = (pt(t.amount) + pt(a)) / 100;
    };
    const out: SummaryAccountRow[] = buckets.map((x) => {
      const acc = x.account_id ? accountById.get(x.account_id) : undefined;
      const bucket = (n: number, a: string): SummaryBucket => ({ count: Number(n), amount: egp(a) });
      add(totals.confirmed, x.confirmed_n, x.confirmed_a);
      add(totals.autoConfirmed, x.auto_n, x.auto_a);
      add(totals.pending, x.pending_n, x.pending_a);
      add(totals.rejectedDebt, x.debt_n, x.debt_a);
      add(totals.rejectedLoss, x.loss_n, x.loss_a);
      let warnings: LimitWarning[] = [];
      if (acc && acc.rail === "wallet") {
        const r = receivedById.get(acc.id);
        try {
          warnings = limitWarnings({
            rail: "wallet",
            provider: acc.provider as CollectionProvider,
            date: b!.date,
            walletOpenedOn: acc.walletOpenedOn,
            dayReceived: fromPiasters(pt(r?.day ?? "0")),
            monthReceived: fromPiasters(pt(r?.month ?? "0")),
            balance: acc.balanceBaseline != null ? fromPiasters(pt(acc.balanceBaseline)) : null,
          });
        } catch {
          warnings = [];
        }
      }
      return {
        accountId: x.account_id,
        label: acc?.label ?? null,
        provider: (acc?.provider as CollectionProvider | undefined) ?? null,
        rail: (acc?.rail as CollectionRail | undefined) ?? null,
        confirmed: bucket(x.confirmed_n, x.confirmed_a),
        autoConfirmed: bucket(x.auto_n, x.auto_a),
        pending: bucket(x.pending_n, x.pending_a),
        rejectedDebt: bucket(x.debt_n, x.debt_a),
        rejectedLoss: bucket(x.loss_n, x.loss_a),
        unmatchedCredits: ZERO(),
        limitWarnings: warnings,
      };
    });
    // Stable order: real accounts by rail + label, the "no account" row last.
    out.sort((p, q) => {
      if (p.accountId === null) return 1;
      if (q.accountId === null) return -1;
      return `${p.rail}|${p.label}`.localeCompare(`${q.rail}|${q.label}`);
    });

    // Cash taken at the counter on split invoices (Q5): total − Σ non-void parts.
    const [cash] = rows<{ remainder: string }>(
      await tx.execute(sql`
        WITH inv AS (
          SELECT DISTINCT c.invoice_id
            FROM collections c
           WHERE c.tenant_id = ${tenantId} AND c.source_type = 'sale' AND c.invoice_id IS NOT NULL
             AND c.rung_at >= ${dayStart}::timestamptz AND c.rung_at < ${dayEnd}::timestamptz
             ${branchFilter}
        )
        SELECT COALESCE(sum(GREATEST(0, t.total - p.parts)), 0)::text AS remainder
          FROM inv
          JOIN LATERAL (SELECT COALESCE(sum(s.total_price), 0) AS total FROM sales s
                         WHERE s.tenant_id = ${tenantId} AND s.invoice_id = inv.invoice_id) t ON true
          JOIN LATERAL (SELECT COALESCE(sum(c2.amount), 0) AS parts FROM collections c2
                         WHERE c2.tenant_id = ${tenantId} AND c2.source_type = 'sale'
                           AND c2.invoice_id = inv.invoice_id AND c2.status <> 'void') p ON true
      `),
    );
    totals.cashRemainder = egp(cash?.remainder ?? "0");

    return { date: b!.date, branchId: input.branchId, accounts: out, totals };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives (05 §4.21) — shared with 07 (auto-confirm, match) and 13
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertCollectionEventInput {
  tenantId: string;
  collectionId: string;
  kind: CollectionEventKind;
  fromStatus?: CollectionStatus | null;
  toStatus?: CollectionStatus | null;
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  creditId?: string | null;
  details?: Record<string, unknown>;
}

/** Append-only: code only ever INSERTs into collection_events (03 §B.2.3). */
export async function insertCollectionEvent(tx: TenantTx, e: InsertCollectionEventInput): Promise<void> {
  await tx.insert(collectionEvents).values({
    tenantId: e.tenantId,
    collectionId: e.collectionId,
    kind: e.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    actorUserId: e.actorUserId ?? null,
    actorDeviceId: e.actorDeviceId ?? null,
    creditId: e.creditId ?? null,
    details: e.details ?? {},
    // clock_timestamp(), not the column's now(): several events written in
    // one transaction (patch: account_changed + note) keep their real order.
    createdAt: sql`clock_timestamp()`,
  });
}

/** Locks every `sale` part of an invoice in part order (05 §4.9) and returns
 *  their ids. Take it BEFORE touching the invoice's sales lines. */
export async function lockInvoiceCollections(tx: TenantTx, tenantId: string, invoiceId: string): Promise<string[]> {
  const r = rows<{ id: string }>(
    await tx.execute(sql`
      SELECT id FROM collections
       WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId} AND source_type = 'sale'
       ORDER BY part_no
       FOR UPDATE
    `),
  );
  return r.map((x) => x.id);
}

/**
 * For mutations that start from sale ids (edit, delete, return): lock the
 * collection parts of those lines' invoices first, keeping the "parts before
 * lines" order. Returns the distinct invoice ids for the post-write hook.
 */
export async function lockCollectionsForSales(
  tx: TenantTx,
  tenantId: string,
  saleIds: readonly string[],
): Promise<string[]> {
  if (saleIds.length === 0) return [];
  const inv = rows<{ invoice_id: string }>(
    await tx.execute(sql`
      SELECT DISTINCT invoice_id FROM sales
       WHERE tenant_id = ${tenantId} AND id IN (${inList(saleIds)}) AND invoice_id IS NOT NULL
       ORDER BY invoice_id
    `),
  ).map((x) => x.invoice_id);
  for (const invoiceId of inv) await lockInvoiceCollections(tx, tenantId, invoiceId);
  return inv;
}

/** Derives the invoice status from its sale parts and writes it on every
 *  line whose value differs (03 §B.2.4). Returns the derived status. */
export async function reconcileInvoiceCollectionStatus(
  tx: TenantTx,
  tenantId: string,
  invoiceId: string,
): Promise<SaleCollectionStatus | null> {
  const parts = await tx
    .select({ status: collections.status })
    .from(collections)
    .where(
      and(
        eq(collections.tenantId, tenantId),
        eq(collections.invoiceId, invoiceId),
        eq(collections.sourceType, "sale"),
      ),
    );
  const status = deriveInvoiceStatus(parts.map((p) => p.status as CollectionStatus));
  await tx.execute(sql`
    SELECT id FROM sales WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId} ORDER BY id FOR UPDATE
  `);
  await tx.execute(sql`
    UPDATE sales SET collection_status = ${status}::text
     WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
       AND collection_status IS DISTINCT FROM ${status}::text
  `);
  return status;
}

export interface DecisionActor {
  userId: string;
  isOwner: boolean;
  /** null = every branch (owner). */
  accessibleBranchIds: string[] | null;
}

/** Four-eyes (03 §E.6): nobody decides a collection they recorded; owners
 *  are exempt (single-owner shops). Used by confirm, reject and 07's match. */
export function assertNotSelfDecision(
  collection: { recordedByUserId: string | null },
  actor: { userId: string; isOwner: boolean },
): void {
  if (!actor.isOwner && collection.recordedByUserId === actor.userId) {
    throw new DomainError("SELF_CONFIRM_FORBIDDEN", 403);
  }
}

export async function loadCollectionForUpdate(
  tx: TenantTx,
  tenantId: string,
  id: string,
): Promise<CollectionRow | null> {
  const [row] = await tx
    .select()
    .from(collections)
    .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)))
    .limit(1)
    .for("update");
  return row ?? null;
}

async function addFlag(tx: TenantTx, tenantId: string, ids: readonly string[], flag: CollectionFlag): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    UPDATE collections
       SET flags = array_append(flags, ${flag}::text), updated_at = now()
     WHERE tenant_id = ${tenantId} AND id IN (${inList(ids)})
       AND NOT (${flag}::text = ANY(flags))
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Create — sale parts (05 §4.6 cart, §4.7 legacy) and settlements (§4.8)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateSaleCollectionsInput {
  tenantId: string;
  branchId: string;
  invoiceId: string;
  /** The invoice's lines in insert order; [0] is the anchor. */
  saleIds: string[];
  /** Normalised (E.164) or null. */
  customerPhone: string | null;
  method: DigitalMethod;
  /** Invoice total in pounds (float allowed; rounded to piasters). */
  total: number;
  collectionAccountId?: string | null;
  collectionParts?: CollectionPartInput[] | null;
  payerPhoneLast4?: string | null;
  payerReference?: string | null;
  rungAt: Date;
  /** Was `rungAt` supplied by the client (offline replay)? */
  customDate?: boolean;
  recordedByUserId: string | null;
  /**
   * `insert` (cart): ON CONFLICT DO NOTHING — a conflict means another cart
   * reused the invoice id. `accumulate` (legacy one-line POST /api/sales):
   * the single part grows by each line's total while it is pending.
   */
  mode?: "insert" | "accumulate";
}

export interface SaleCollectionsResult {
  /** Every part this call created (or grew, legacy). */
  collectionIds: string[];
  /** Ids of rows INSERTed by this call (fanout only when > 0). */
  insertedIds: string[];
  /** Σ of the parts this call wrote, in pounds. */
  amountEgp: number;
  partsCount: number;
  /** First part's account label (the fanout payload). */
  accountLabel: string | null;
  matchEffects: MatchEffects;
}

export const NO_SALE_COLLECTIONS: Readonly<SaleCollectionsResult> = Object.freeze({
  collectionIds: [],
  insertedIds: [],
  amountEgp: 0,
  partsCount: 0,
  accountLabel: null,
  matchEffects: EMPTY_EFFECTS,
}) as SaleCollectionsResult;

/**
 * "Book and flag, never refuse" (03 §C.1 rule 1): an unknown or archived
 * account, parts above the total or an invoice-id collision never throw —
 * the sale books and the part carries a flag. Only programmer errors throw.
 */
export async function createSaleCollections(
  tx: TenantTx,
  input: CreateSaleCollectionsInput,
): Promise<SaleCollectionsResult> {
  const mode = input.mode ?? "insert";
  const norm = normaliseParts({
    total: input.total,
    collectionAccountId: input.collectionAccountId ?? null,
    collectionParts: mode === "accumulate" ? null : input.collectionParts ?? null,
    payerPhoneLast4: input.payerPhoneLast4 ?? null,
    payerReference: input.payerReference ?? null,
  });
  if (norm.parts.length === 0) return { ...NO_SALE_COLLECTIONS };

  const givenIds = norm.parts.map((p) => p.accountId).filter((x): x is string => !!x);
  const resolution = await resolvePartAccounts(tx, input.tenantId, input.branchId, input.method, givenIds);
  const offline = !!input.customDate && input.rungAt.getTime() < Date.now() - OFFLINE_RUNG_MS;
  const anchor = input.saleIds[0] ?? null;

  const collectionIds: string[] = [];
  const insertedIds: string[] = [];
  let amountPt = 0;
  let accountLabel: string | null = null;

  for (const part of norm.parts) {
    const flags: CollectionFlag[] = [];
    let accountId: string | null = null;
    let label: string | null = null;
    if (part.accountId) {
      const found = resolution.byId.get(part.accountId);
      if (found) {
        accountId = found.id;
        label = found.label;
        if (found.archived) flags.push("account_inactive");
      } else {
        flags.push("account_missing");
      }
    } else if (resolution.posDefault) {
      accountId = resolution.posDefault.id;
      label = resolution.posDefault.label;
    } else {
      flags.push("account_missing");
    }
    if (norm.clamped) flags.push("parts_clamped");
    if (offline) flags.push("offline_rung");
    if (part.partNo === 1) accountLabel = label;

    const values = {
      tenantId: input.tenantId,
      branchId: input.branchId,
      sourceType: "sale" as const,
      invoiceId: input.invoiceId,
      anchorSaleId: anchor,
      customerPhone: input.customerPhone,
      method: input.method,
      collectionAccountId: accountId,
      amount: fromPiasters(part.amountPt),
      partNo: part.partNo,
      status: "pending" as const,
      payerPhoneLast4: part.payerPhoneLast4,
      payerReference: part.payerReference,
      rungAt: input.rungAt,
      recordedByUserId: input.recordedByUserId,
      flags,
    };

    if (mode === "insert") {
      const [row] = await tx
        .insert(collections)
        .values(values)
        .onConflictDoNothing({
          target: [collections.tenantId, collections.invoiceId, collections.partNo],
          where: sql`source_type = 'sale'`,
        })
        .returning({ id: collections.id });
      if (!row) {
        // A true replay never gets here (the anchor INSERT already failed on
        // sales_tenant_idempotency_key_idx), so another cart reused the
        // invoice id. The sale still books; this part gets no collection.
        logger.warn({
          event: "collections.invoice_id_collision",
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          partNo: part.partNo,
        });
        continue;
      }
      collectionIds.push(row.id);
      insertedIds.push(row.id);
      amountPt += part.amountPt;
      await insertCollectionEvent(tx, {
        tenantId: input.tenantId,
        collectionId: row.id,
        kind: "created",
        toStatus: "pending",
        actorUserId: input.recordedByUserId,
        details: { partsCount: norm.parts.length, flags },
      });
    } else {
      // Legacy single-line route: one part per invoice that accumulates.
      const res = rows<{ id: string; inserted: boolean; amount: string }>(
        await tx.execute(sql`
          INSERT INTO collections (tenant_id, branch_id, source_type, invoice_id, anchor_sale_id, customer_phone,
                                   method, collection_account_id, amount, part_no, status, payer_phone_last4,
                                   payer_reference, rung_at, recorded_by_user_id, flags)
          VALUES (${input.tenantId}, ${input.branchId}, 'sale', ${input.invoiceId}, ${anchor}, ${input.customerPhone},
                  ${input.method}, ${accountId}, ${fromPiasters(part.amountPt)}::numeric, 1, 'pending',
                  ${part.payerPhoneLast4}, ${part.payerReference}, ${input.rungAt.toISOString()}::timestamptz,
                  ${input.recordedByUserId},
                  ${flags.length ? sql`ARRAY[${inList(flags)}]::text[]` : sql`'{}'::text[]`})
          ON CONFLICT (tenant_id, invoice_id, part_no) WHERE source_type = 'sale'
          DO UPDATE SET amount = collections.amount + EXCLUDED.amount, updated_at = now()
           WHERE collections.status = 'pending'
          RETURNING id, (xmax = 0) AS inserted, amount::text AS amount
        `),
      );
      const row = res[0];
      if (row) {
        collectionIds.push(row.id);
        amountPt += part.amountPt;
        if (row.inserted) {
          insertedIds.push(row.id);
          await insertCollectionEvent(tx, {
            tenantId: input.tenantId,
            collectionId: row.id,
            kind: "created",
            toStatus: "pending",
            actorUserId: input.recordedByUserId,
            details: { partsCount: 1, flags },
          });
        } else {
          const to = pt(row.amount);
          await insertCollectionEvent(tx, {
            tenantId: input.tenantId,
            collectionId: row.id,
            kind: "amount_changed",
            fromStatus: "pending",
            toStatus: "pending",
            actorUserId: input.recordedByUserId,
            details: { from: fromPiasters(to - part.amountPt), to: fromPiasters(to), source: "legacy_line" },
          });
        }
      } else {
        // The existing part was already decided: never edit a decided amount
        // (§8 R11) — flag it instead.
        const [existing] = await tx
          .select({ id: collections.id })
          .from(collections)
          .where(
            and(
              eq(collections.tenantId, input.tenantId),
              eq(collections.invoiceId, input.invoiceId),
              eq(collections.sourceType, "sale"),
              eq(collections.partNo, 1),
            ),
          )
          .limit(1);
        if (existing) {
          await addFlag(tx, input.tenantId, [existing.id], "total_changed");
          await insertCollectionEvent(tx, {
            tenantId: input.tenantId,
            collectionId: existing.id,
            kind: "note",
            actorUserId: input.recordedByUserId,
            details: { reason: "total_changed", addedLine: fromPiasters(part.amountPt) },
          });
        }
      }
    }
  }

  if (collectionIds.length === 0 && mode === "insert") return { ...NO_SALE_COLLECTIONS };
  await reconcileInvoiceCollectionStatus(tx, input.tenantId, input.invoiceId);
  const matchEffects = insertedIds.length > 0 ? await reverseMatch(tx, input.tenantId, insertedIds) : EMPTY_EFFECTS;
  return {
    collectionIds,
    insertedIds,
    amountEgp: amountPt / 100,
    partsCount: norm.parts.length,
    accountLabel,
    matchEffects,
  };
}

export interface CreateSettlementCollectionInput {
  tenantId: string;
  branchId: string;
  method: DigitalMethod;
  /** Applied amount in pounds (> 0). */
  amount: number;
  /** Set when exactly one invoice was settled. */
  invoiceId: string | null;
  anchorSaleId: string | null;
  customerPhone: string;
  accountId?: string | null;
  payerPhoneLast4?: string | null;
  payerReference?: string | null;
  recordedByUserId: string;
  /** The sale_payments rows the settlement wrote. */
  paymentIds: string[];
}

/** One `settlement` row, part 1, amount = applied; stamps the sale_payments
 *  rows with its id. Settlement parts never write sales.collection_status. */
export async function createSettlementCollection(
  tx: TenantTx,
  input: CreateSettlementCollectionInput,
): Promise<{ id: string; accountLabel: string | null } | null> {
  const amountPt = roundToPiasters(input.amount);
  if (amountPt <= 0) return null;
  const ids = input.accountId ? [input.accountId] : [];
  const resolution = await resolvePartAccounts(tx, input.tenantId, input.branchId, input.method, ids);
  const flags: CollectionFlag[] = [];
  let accountId: string | null = null;
  let label: string | null = null;
  if (input.accountId) {
    const found = resolution.byId.get(input.accountId);
    if (found) {
      accountId = found.id;
      label = found.label;
      if (found.archived) flags.push("account_inactive");
    } else flags.push("account_missing");
  } else if (resolution.posDefault) {
    accountId = resolution.posDefault.id;
    label = resolution.posDefault.label;
  } else flags.push("account_missing");

  const [row] = await tx
    .insert(collections)
    .values({
      tenantId: input.tenantId,
      branchId: input.branchId,
      sourceType: "settlement",
      invoiceId: input.invoiceId,
      anchorSaleId: input.anchorSaleId,
      customerPhone: input.customerPhone,
      method: input.method,
      collectionAccountId: accountId,
      amount: fromPiasters(amountPt),
      partNo: 1,
      status: "pending",
      payerPhoneLast4: input.payerPhoneLast4 ?? null,
      payerReference: input.payerReference ? input.payerReference.trim().toLowerCase() : null,
      rungAt: new Date(),
      recordedByUserId: input.recordedByUserId,
      flags,
    })
    .returning({ id: collections.id });
  await insertCollectionEvent(tx, {
    tenantId: input.tenantId,
    collectionId: row!.id,
    kind: "created",
    toStatus: "pending",
    actorUserId: input.recordedByUserId,
    details: { partsCount: 1, flags, paymentIds: input.paymentIds },
  });
  if (input.paymentIds.length > 0) {
    await tx.execute(sql`
      UPDATE sale_payments SET collection_id = ${row!.id}
       WHERE tenant_id = ${input.tenantId} AND id IN (${inList(input.paymentIds)})
    `);
  }
  return { id: row!.id, accountLabel: label };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions — confirm / reject / reopen / patch
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionResult {
  dto: CollectionDTO;
  /** The durable fallback answered (Redis had lost the key): nothing written. */
  replayed: boolean;
}

function withinHours(at: Date | string | null, hours: number): boolean {
  if (!at) return false;
  const t = (at instanceof Date ? at : new Date(at)).getTime();
  return Date.now() - t < hours * 3_600_000;
}

/**
 * Opens the decision transaction's locks in the house order and returns the
 * locked row. Missing or out-of-reach → 404 COLLECTION_NOT_FOUND.
 */
async function lockForDecision(
  tx: TenantTx,
  tenantId: string,
  id: string,
  actor: DecisionActor,
): Promise<CollectionRow> {
  const [head] = await tx
    .select({ sourceType: collections.sourceType, invoiceId: collections.invoiceId, branchId: collections.branchId })
    .from(collections)
    .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)))
    .limit(1);
  if (!head || !branchReachable(head.branchId, actor)) throw new DomainError("COLLECTION_NOT_FOUND", 404);
  if (head.sourceType === "sale" && head.invoiceId) await lockInvoiceCollections(tx, tenantId, head.invoiceId);
  const row = await loadCollectionForUpdate(tx, tenantId, id);
  if (!row) throw new DomainError("COLLECTION_NOT_FOUND", 404);
  return row;
}

async function finishDecision(tx: TenantTx, tenantId: string, row: CollectionRow): Promise<CollectionDTO> {
  if (row.sourceType === "sale" && row.invoiceId) {
    await reconcileInvoiceCollectionStatus(tx, tenantId, row.invoiceId);
  }
  const dto = await readDto(tx, tenantId, row.id);
  if (!dto) throw new DomainError("COLLECTION_NOT_FOUND", 404);
  return dto;
}

export async function confirmCollection(
  tenantId: string,
  id: string,
  actor: DecisionActor,
  body: { note?: string | null },
): Promise<DecisionResult> {
  const result = await withTenant(tenantId, async (tx) => {
    const row = await lockForDecision(tx, tenantId, id, actor);
    if (
      row.status === "confirmed" &&
      row.decidedByUserId === actor.userId &&
      withinHours(row.decidedAt, DECISION_REPLAY_HOURS)
    ) {
      return { dto: (await readDto(tx, tenantId, id))!, replayed: true };
    }
    if (row.status !== "pending") throw new DomainError("COLLECTION_NOT_PENDING", 409, { status: row.status });
    assertNotSelfDecision(row, actor);
    await tx
      .update(collections)
      .set({
        status: "confirmed",
        decidedByUserId: actor.userId,
        decidedAt: sql`now()`,
        decisionNote: body.note?.trim() || null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)));
    await insertCollectionEvent(tx, {
      tenantId,
      collectionId: id,
      kind: "confirmed",
      fromStatus: "pending",
      toStatus: "confirmed",
      actorUserId: actor.userId,
      details: body.note?.trim() ? { note: body.note.trim() } : {},
    });
    return { dto: await finishDecision(tx, tenantId, row), replayed: false };
  });
  if (!result.replayed) await bustInsightsCache(tenantId);
  return result;
}

// ── Reject ──────────────────────────────────────────────────────────────────

interface LineState {
  amountPaid: string;
  isPaid: boolean;
  paidAt: string | null;
  partialPaidAt: string | null;
  paymentMethod: string | null;
  customerPhone: string | null;
  totalPrice: string;
}

interface LineSnapshot {
  saleId: string;
  before: LineState;
  after: LineState;
}

export interface RejectDetails {
  outcome: RejectOutcome;
  lines: LineSnapshot[];
  voidedPaymentIds: string[];
  unallocated: string;
  /** The live (non-voided) sale_payments on those lines right after the
   *  rejection. Reopen treats any other live payment as "a settle happened
   *  since" — by id, so app-server vs database clock skew cannot matter. */
  livePaymentIds?: string[];
}

/** Live sale_payments ids on these lines (after this transaction's voids). */
async function livePaymentIdsOn(tx: TenantTx, tenantId: string, saleIds: readonly string[]): Promise<string[]> {
  if (saleIds.length === 0) return [];
  return rows<{ id: string }>(
    await tx.execute(sql`
      SELECT id FROM sale_payments
       WHERE tenant_id = ${tenantId} AND sale_id IN (${inList(saleIds)}) AND voided_at IS NULL
       ORDER BY id
    `),
  ).map((r) => r.id);
}

interface LockedLine extends LineState {
  id: string;
  saleDate: string;
  isReturned: boolean;
}

/** Sales lines as exact text (numeric + µs timestamps), locked in id order,
 *  so a snapshot restores byte-for-byte (acceptance 8). */
async function lockLines(tx: TenantTx, tenantId: string, where: SQL): Promise<LockedLine[]> {
  const r = rows<{
    id: string;
    sale_date: string;
    total_price: string;
    amount_paid: string;
    is_paid: boolean;
    paid_at: string | null;
    partial_paid_at: string | null;
    payment_method: string | null;
    customer_phone: string | null;
    is_returned: boolean;
  }>(
    await tx.execute(sql`
      SELECT id, to_json(sale_date) #>> '{}' AS sale_date, total_price::text AS total_price,
             amount_paid::text AS amount_paid, is_paid,
             to_json(paid_at) #>> '{}' AS paid_at, to_json(partial_paid_at) #>> '{}' AS partial_paid_at,
             payment_method, customer_phone, is_returned
        FROM sales
       WHERE tenant_id = ${tenantId} AND ${where}
       ORDER BY id
       FOR UPDATE
    `),
  );
  return r.map((x) => ({
    id: x.id,
    saleDate: x.sale_date,
    isReturned: x.is_returned,
    amountPaid: x.amount_paid,
    isPaid: x.is_paid,
    paidAt: x.paid_at,
    partialPaidAt: x.partial_paid_at,
    paymentMethod: x.payment_method,
    customerPhone: x.customer_phone,
    totalPrice: x.total_price,
  }));
}

function stateOf(l: LockedLine): LineState {
  return {
    amountPaid: l.amountPaid,
    isPaid: l.isPaid,
    paidAt: l.paidAt,
    partialPaidAt: l.partialPaidAt,
    paymentMethod: l.paymentMethod,
    customerPhone: l.customerPhone,
    totalPrice: l.totalPrice,
  };
}

async function writeLine(tx: TenantTx, tenantId: string, saleId: string, s: LineState): Promise<void> {
  await tx.execute(sql`
    UPDATE sales
       SET amount_paid     = ${s.amountPaid}::numeric,
           is_paid         = ${s.isPaid},
           paid_at         = ${s.paidAt}::timestamptz,
           partial_paid_at = ${s.partialPaidAt}::timestamptz,
           payment_method  = ${s.paymentMethod}::text,
           customer_phone  = ${s.customerPhone}::text
     WHERE tenant_id = ${tenantId} AND id = ${saleId}
  `);
}

/** is_paid / paid_at / partial_paid_at after amount_paid drops to `newPt`. */
function recomputePaid(l: LockedLine, newPt: number, partialAt: string | null): Pick<LineState, "amountPaid" | "isPaid" | "paidAt" | "partialPaidAt"> {
  const totalPt = pt(l.totalPrice);
  const isPaid = newPt >= totalPt && totalPt > 0;
  return {
    amountPaid: fromPiasters(newPt),
    isPaid,
    paidAt: isPaid ? l.paidAt : null,
    partialPaidAt: newPt > 0 && newPt < totalPt ? partialAt : null,
  };
}

export interface RejectInput {
  reason: RejectReason;
  outcome?: RejectOutcome;
  /** Already normalised to E.164 by the route (400 INVALID_PHONE otherwise). */
  customerPhone?: string | null;
  note?: string | null;
}

export async function rejectCollection(
  tenantId: string,
  id: string,
  actor: DecisionActor,
  body: RejectInput,
): Promise<DecisionResult & { outcome: RejectOutcome }> {
  const result = await withTenant(tenantId, async (tx) => {
    const row = await lockForDecision(tx, tenantId, id, actor);
    if (
      row.status === "rejected" &&
      row.decidedByUserId === actor.userId &&
      row.rejectReason === body.reason &&
      withinHours(row.decidedAt, DECISION_REPLAY_HOURS)
    ) {
      return {
        dto: (await readDto(tx, tenantId, id))!,
        replayed: true,
        outcome: (row.rejectOutcome as RejectOutcome) ?? "loss",
      };
    }
    if (row.status !== "pending") throw new DomainError("COLLECTION_NOT_PENDING", 409, { status: row.status });
    assertNotSelfDecision(row, actor);

    const amountPt = pt(row.amount);
    let details: RejectDetails;
    let outcome: RejectOutcome;

    if (row.sourceType === "settlement") {
      // A settlement always has a phone: the rejection restores the debt.
      outcome = "debt";
      const payments = rows<{ id: string; sale_id: string; amount: string }>(
        await tx.execute(sql`
          SELECT id, sale_id, amount::text AS amount FROM sale_payments
           WHERE tenant_id = ${tenantId} AND collection_id = ${id} AND voided_at IS NULL
           ORDER BY id
           FOR UPDATE
        `),
      );
      const bySale = new Map<string, number>();
      for (const p of payments) bySale.set(p.sale_id, (bySale.get(p.sale_id) ?? 0) + pt(p.amount));
      const lines = bySale.size
        ? await lockLines(tx, tenantId, sql`id IN (${inList([...bySale.keys()])})`)
        : [];
      const snapshots: LineSnapshot[] = [];
      let unallocatedPt = 0;
      for (const l of lines) {
        const take = bySale.get(l.id) ?? 0;
        const paidPt = pt(l.amountPaid);
        const newPt = Math.max(0, paidPt - take);
        unallocatedPt += Math.max(0, take - paidPt);
        const before = stateOf(l);
        const after: LineState = {
          ...before,
          ...recomputePaid(l, newPt, l.partialPaidAt ?? l.saleDate),
        };
        await writeLine(tx, tenantId, l.id, after);
        snapshots.push({ saleId: l.id, before, after });
      }
      const voidedPaymentIds = payments.map((p) => p.id);
      if (voidedPaymentIds.length > 0) {
        await tx.execute(sql`
          UPDATE sale_payments SET voided_at = now()
           WHERE tenant_id = ${tenantId} AND id IN (${inList(voidedPaymentIds)})
        `);
      }
      details = {
        outcome,
        lines: snapshots,
        voidedPaymentIds,
        unallocated: fromPiasters(unallocatedPt),
        livePaymentIds: await livePaymentIdsOn(tx, tenantId, snapshots.map((x) => x.saleId)),
      };
    } else {
      const lines = row.invoiceId ? await lockLines(tx, tenantId, sql`invoice_id = ${row.invoiceId}`) : [];
      const phone =
        lines.find((l) => l.customerPhone)?.customerPhone ?? row.customerPhone ?? body.customerPhone ?? null;
      outcome = body.outcome ?? (phone ? "debt" : "loss");
      if (outcome === "debt" && !phone) throw new DomainError("REJECT_OUTCOME_REQUIRES_PHONE", 400);
      if (outcome === "debt") {
        const alloc = allocateRejection(
          lines.map((l) => ({
            saleId: l.id,
            saleDate: l.saleDate,
            totalPricePt: pt(l.totalPrice),
            amountPaidPt: pt(l.amountPaid),
            isReturned: l.isReturned,
          })),
          amountPt,
        );
        const touched = new Map(alloc.allocations.map((a) => [a.saleId, a] as const));
        const snapshots: LineSnapshot[] = [];
        for (const l of lines) {
          const before = stateOf(l);
          const a = touched.get(l.id);
          const after: LineState = {
            ...before,
            // The cash remainder of a split was paid at the sale.
            ...(a ? recomputePaid(l, a.newAmountPaidPt, l.saleDate) : {}),
            paymentMethod: "deferred",
            customerPhone: l.customerPhone ?? phone,
          };
          await writeLine(tx, tenantId, l.id, after);
          snapshots.push({ saleId: l.id, before, after });
        }
        details = {
          outcome,
          lines: snapshots,
          voidedPaymentIds: [],
          unallocated: fromPiasters(alloc.unallocatedPt),
          livePaymentIds: await livePaymentIdsOn(tx, tenantId, snapshots.map((x) => x.saleId)),
        };
      } else {
        // Loss: the lines stay as taken; the summary shows it under
        // rejectedLoss with the recording cashier.
        details = { outcome, lines: [], voidedPaymentIds: [], unallocated: "0.00" };
      }
    }

    await tx
      .update(collections)
      .set({
        status: "rejected",
        rejectReason: body.reason,
        rejectOutcome: outcome,
        decisionNote: body.note?.trim() || null,
        decidedByUserId: actor.userId,
        decidedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)));
    await insertCollectionEvent(tx, {
      tenantId,
      collectionId: id,
      kind: "rejected",
      fromStatus: "pending",
      toStatus: "rejected",
      actorUserId: actor.userId,
      details: { ...details, reason: body.reason, ...(body.note?.trim() ? { note: body.note.trim() } : {}) },
    });
    return { dto: await finishDecision(tx, tenantId, row), replayed: false, outcome };
  });
  if (!result.replayed) await bustInsightsCache(tenantId);
  return result;
}

// ── Reopen ──────────────────────────────────────────────────────────────────

export async function reopenCollection(
  tenantId: string,
  id: string,
  actor: DecisionActor,
  body: { note?: string | null },
): Promise<DecisionResult & { fromStatus: CollectionStatus | null }> {
  if (!actor.isOwner) throw new DomainError("Forbidden", 403);
  const result = await withTenant(tenantId, async (tx) => {
    const row = await lockForDecision(tx, tenantId, id, actor);
    if (row.status === "pending") {
      const [last] = await tx
        .select({ actorUserId: collectionEvents.actorUserId, createdAt: collectionEvents.createdAt, fromStatus: collectionEvents.fromStatus })
        .from(collectionEvents)
        .where(
          and(
            eq(collectionEvents.tenantId, tenantId),
            eq(collectionEvents.collectionId, id),
            eq(collectionEvents.kind, "reopened"),
          ),
        )
        .orderBy(sql`${collectionEvents.createdAt} DESC`)
        .limit(1);
      if (last && last.actorUserId === actor.userId && withinHours(last.createdAt, DECISION_REPLAY_HOURS)) {
        return {
          dto: (await readDto(tx, tenantId, id))!,
          replayed: true,
          fromStatus: (last.fromStatus as CollectionStatus | null) ?? null,
        };
      }
    }
    if (row.status !== "confirmed" && row.status !== "auto_confirmed" && row.status !== "rejected") {
      throw new DomainError("COLLECTION_NOT_REOPENABLE", 409, { status: row.status });
    }
    const [win] = rows<{ open: boolean }>(
      await tx.execute(sql`
        SELECT (decided_at IS NOT NULL AND now() - decided_at <= make_interval(days => ${REOPEN_DAYS})) AS open
          FROM collections WHERE tenant_id = ${tenantId} AND id = ${id}
      `),
    );
    if (!win?.open) throw new DomainError("REOPEN_WINDOW_CLOSED", 409);

    const fromStatus = row.status as CollectionStatus;
    if (row.status === "rejected") {
      const [ev] = await tx
        .select({ details: collectionEvents.details })
        .from(collectionEvents)
        .where(
          and(
            eq(collectionEvents.tenantId, tenantId),
            eq(collectionEvents.collectionId, id),
            eq(collectionEvents.kind, "rejected"),
          ),
        )
        .orderBy(sql`${collectionEvents.createdAt} DESC`, sql`${collectionEvents.id} DESC`)
        .limit(1);
      const d = (ev?.details ?? {}) as Partial<RejectDetails>;
      const snaps = Array.isArray(d.lines) ? d.lines : [];
      const voidedIds = Array.isArray(d.voidedPaymentIds) ? d.voidedPaymentIds : [];
      if (snaps.length > 0) {
        const saleIds = snaps.map((s) => s.saleId);
        const locked = await lockLines(tx, tenantId, sql`id IN (${inList(saleIds)})`);
        const byId = new Map(locked.map((l) => [l.id, l] as const));
        // A settle / mark-all-paid on the debt since the rejection: a live
        // payment the rejection did not know about (by id; events written
        // before `livePaymentIds` existed fall back to recorded_at).
        let late = 0;
        if (Array.isArray(d.livePaymentIds)) {
          const known = new Set(d.livePaymentIds);
          late = (await livePaymentIdsOn(tx, tenantId, saleIds)).filter((pid) => !known.has(pid)).length;
        } else {
          const [n] = rows<{ n: number }>(
            await tx.execute(sql`
              SELECT count(*)::int AS n FROM sale_payments
               WHERE tenant_id = ${tenantId} AND sale_id IN (${inList(saleIds)})
                 AND voided_at IS NULL AND recorded_at > ${toIso(row.decidedAt)}::timestamptz
            `),
          );
          late = Number(n?.n ?? 0);
        }
        if (late > 0) {
          throw new DomainError("REOPEN_BLOCKED_SETTLED", 409, { reason: "payment_after_reject" });
        }
        for (const s of snaps) {
          const cur = byId.get(s.saleId);
          if (
            !cur ||
            pt(cur.amountPaid) !== pt(s.after.amountPaid) ||
            (cur.paymentMethod ?? null) !== (s.after.paymentMethod ?? null) ||
            pt(cur.totalPrice) !== pt(s.after.totalPrice)
          ) {
            throw new DomainError("REOPEN_BLOCKED_SETTLED", 409, { reason: "lines_changed" });
          }
        }
        if (voidedIds.length > 0) {
          const [{ n }] = rows<{ n: number }>(
            await tx.execute(sql`
              SELECT count(*)::int AS n FROM sale_payments
               WHERE tenant_id = ${tenantId} AND id IN (${inList(voidedIds)})
            `),
          );
          if (Number(n) !== voidedIds.length) {
            throw new DomainError("REOPEN_BLOCKED_SETTLED", 409, { reason: "lines_changed" });
          }
        }
        for (const s of snaps) await writeLine(tx, tenantId, s.saleId, s.before);
        if (voidedIds.length > 0) {
          await tx.execute(sql`
            UPDATE sale_payments SET voided_at = NULL
             WHERE tenant_id = ${tenantId} AND id IN (${inList(voidedIds)})
          `);
        }
      }
    }

    await tx
      .update(collections)
      .set({
        status: "pending",
        decidedByUserId: null,
        decidedAt: null,
        rejectReason: null,
        rejectOutcome: null,
        decisionNote: null,
        staleNotifiedAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)));
    await releaseCredits(tx, tenantId, [id], "reopened");
    await insertCollectionEvent(tx, {
      tenantId,
      collectionId: id,
      kind: "reopened",
      fromStatus,
      toStatus: "pending",
      actorUserId: actor.userId,
      details: { fromStatus, ...(body.note?.trim() ? { note: body.note.trim() } : {}) },
    });
    return { dto: await finishDecision(tx, tenantId, row), replayed: false, fromStatus };
  });
  if (!result.replayed) await bustInsightsCache(tenantId);
  return result;
}

// ── Patch (payer hints / account while pending) ─────────────────────────────

export interface PatchCollectionInput {
  collectionAccountId?: string;
  payerPhoneLast4?: string | null;
  payerReference?: string | null;
}

export async function updatePendingCollection(
  tenantId: string,
  id: string,
  actor: DecisionActor & { mustBeRecorder: boolean },
  patch: PatchCollectionInput,
): Promise<{ dto: CollectionDTO; changed: string[] }> {
  return withTenant(tenantId, async (tx) => {
    const row = await lockForDecision(tx, tenantId, id, actor);
    if (actor.mustBeRecorder && row.recordedByUserId !== actor.userId) {
      throw new DomainError("Forbidden", 403);
    }
    if (row.status !== "pending") throw new DomainError("COLLECTION_NOT_PENDING", 409, { status: row.status });
    const set: Record<string, unknown> = {};
    const changedPayer: string[] = [];
    let accountChange: { from: string | null; to: string } | null = null;

    if (patch.collectionAccountId !== undefined && patch.collectionAccountId !== row.collectionAccountId) {
      const [acc] = await tx
        .select({ id: collectionAccounts.id, archivedAt: collectionAccounts.archivedAt })
        .from(collectionAccounts)
        .where(and(eq(collectionAccounts.tenantId, tenantId), eq(collectionAccounts.id, patch.collectionAccountId)))
        .limit(1);
      if (!acc || acc.archivedAt) throw new DomainError("COLLECTION_ACCOUNT_NOT_FOUND", 404);
      set.collectionAccountId = acc.id;
      set.flags = (row.flags ?? []).filter((f) => f !== "account_missing" && f !== "account_inactive");
      accountChange = { from: row.collectionAccountId, to: acc.id };
    }
    if (patch.payerPhoneLast4 !== undefined && (patch.payerPhoneLast4 || null) !== row.payerPhoneLast4) {
      set.payerPhoneLast4 = patch.payerPhoneLast4 || null;
      changedPayer.push("payerPhoneLast4");
    }
    const ref = patch.payerReference === undefined ? undefined : patch.payerReference ? patch.payerReference.toLowerCase() : null;
    if (ref !== undefined && ref !== row.payerReference) {
      set.payerReference = ref;
      changedPayer.push("payerReference");
    }
    if (Object.keys(set).length > 0) {
      await tx
        .update(collections)
        .set({ ...set, updatedAt: sql`now()` })
        .where(and(eq(collections.tenantId, tenantId), eq(collections.id, id)));
    }
    if (accountChange) {
      await insertCollectionEvent(tx, {
        tenantId,
        collectionId: id,
        kind: "account_changed",
        fromStatus: "pending",
        toStatus: "pending",
        actorUserId: actor.userId,
        details: accountChange,
      });
    }
    if (changedPayer.length > 0) {
      await insertCollectionEvent(tx, {
        tenantId,
        collectionId: id,
        kind: "note",
        actorUserId: actor.userId,
        details: { changed: changedPayer },
      });
    }
    const dto = await readDto(tx, tenantId, id);
    return {
      dto: dto!,
      changed: [...(accountChange ? ["collectionAccountId"] : []), ...changedPayer],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle hooks for existing mutations (05 §4.12, 03 §F)
// ─────────────────────────────────────────────────────────────────────────────

async function liveSaleParts(
  tx: TenantTx,
  tenantId: string,
  invoiceId: string,
): Promise<{ id: string; status: string; amount: string }[]> {
  return tx
    .select({ id: collections.id, status: collections.status, amount: collections.amount })
    .from(collections)
    .where(
      and(
        eq(collections.tenantId, tenantId),
        eq(collections.invoiceId, invoiceId),
        eq(collections.sourceType, "sale"),
        ne(collections.status, "void"),
      ),
    )
    .orderBy(asc(collections.partNo));
}

/**
 * After `updateSale` rewrote one line: a pure-transfer invoice (exactly one
 * live part, pending, equal to the OLD invoice total) follows the new total
 * (`amount_changed`); every other case is flagged `total_changed` (+ `note`).
 * Call `lockCollectionsForSales` before the UPDATE to keep the lock order.
 */
export async function onSaleUpdated(
  tx: TenantTx,
  tenantId: string,
  saleId: string,
  oldLineTotal: number | string,
): Promise<void> {
  const [line] = rows<{ invoice_id: string | null; total_price: string }>(
    await tx.execute(sql`
      SELECT invoice_id, total_price::text AS total_price FROM sales WHERE tenant_id = ${tenantId} AND id = ${saleId}
    `),
  );
  if (!line?.invoice_id) return;
  const parts = await liveSaleParts(tx, tenantId, line.invoice_id);
  if (parts.length === 0) return;
  const [inv] = rows<{ total: string }>(
    await tx.execute(sql`
      SELECT COALESCE(sum(total_price), 0)::text AS total FROM sales
       WHERE tenant_id = ${tenantId} AND invoice_id = ${line.invoice_id}
    `),
  );
  const newTotalPt = pt(inv?.total ?? "0");
  const oldTotalPt = newTotalPt - pt(line.total_price) + pt(oldLineTotal);
  if (newTotalPt === oldTotalPt) return;
  const only = parts.length === 1 ? parts[0]! : null;
  if (only && only.status === "pending" && pt(only.amount) === oldTotalPt && newTotalPt > 0) {
    await tx
      .update(collections)
      .set({ amount: fromPiasters(newTotalPt), updatedAt: sql`now()` })
      .where(and(eq(collections.tenantId, tenantId), eq(collections.id, only.id)));
    await insertCollectionEvent(tx, {
      tenantId,
      collectionId: only.id,
      kind: "amount_changed",
      fromStatus: "pending",
      toStatus: "pending",
      details: { from: fromPiasters(oldTotalPt), to: fromPiasters(newTotalPt), saleId },
    });
    return;
  }
  await addFlag(tx, tenantId, parts.map((p) => p.id), "total_changed");
  for (const p of parts) {
    await insertCollectionEvent(tx, {
      tenantId,
      collectionId: p.id,
      kind: "note",
      details: { reason: "total_changed", from: fromPiasters(oldTotalPt), to: fromPiasters(newTotalPt), saleId },
    });
  }
}

/**
 * After `voidSale` / `bulkDeleteSales` deleted lines: an invoice with no line
 * left voids its live sale parts (credits released); an invoice with lines
 * left is flagged `total_changed`. Settlement collections are untouched —
 * the transfer is still owed to the shop.
 */
export async function onSaleLinesDeleted(
  tx: TenantTx,
  tenantId: string,
  invoiceIds: readonly string[],
): Promise<void> {
  for (const invoiceId of new Set(invoiceIds)) {
    const parts = await liveSaleParts(tx, tenantId, invoiceId);
    if (parts.length === 0) continue;
    const [left] = rows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM sales WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
      `),
    );
    if (Number(left?.n ?? 0) === 0) {
      const ids = parts.map((p) => p.id);
      await tx.execute(sql`
        UPDATE collections SET status = 'void', updated_at = now()
         WHERE tenant_id = ${tenantId} AND id IN (${inList(ids)})
      `);
      for (const p of parts) {
        await insertCollectionEvent(tx, {
          tenantId,
          collectionId: p.id,
          kind: "voided",
          fromStatus: p.status as CollectionStatus,
          toStatus: "void",
          details: { reason: "sale_deleted", previousStatus: p.status },
        });
      }
      await releaseCredits(tx, tenantId, ids, "sale_deleted");
    } else {
      await addFlag(tx, tenantId, parts.map((p) => p.id), "total_changed");
      for (const p of parts) {
        await insertCollectionEvent(tx, {
          tenantId,
          collectionId: p.id,
          kind: "note",
          details: { reason: "lines_deleted" },
        });
      }
    }
  }
}

/** After `recordReturn`: flag `returned` + a `note`; no money change
 *  (refunds are the owner's outgoing transfers, 03 §C.4). */
export async function onSaleReturned(
  tx: TenantTx,
  tenantId: string,
  saleId: string,
  returnId: string,
  qty: number,
): Promise<void> {
  const [line] = rows<{ invoice_id: string | null }>(
    await tx.execute(sql`SELECT invoice_id FROM sales WHERE tenant_id = ${tenantId} AND id = ${saleId}`),
  );
  if (!line?.invoice_id) return;
  const parts = await liveSaleParts(tx, tenantId, line.invoice_id);
  if (parts.length === 0) return;
  await addFlag(tx, tenantId, parts.map((p) => p.id), "returned");
  for (const p of parts) {
    await insertCollectionEvent(tx, {
      tenantId,
      collectionId: p.id,
      kind: "note",
      details: { reason: "returned", returnId, qty, saleId },
    });
  }
}

/** Replay support for the cart's durable path: the ids the first 201 carried. */
export async function saleCollectionIdsForInvoice(
  tx: TenantTx,
  tenantId: string,
  invoiceId: string,
): Promise<string[]> {
  const r = await tx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.tenantId, tenantId),
        eq(collections.invoiceId, invoiceId),
        eq(collections.sourceType, "sale"),
      ),
    )
    .orderBy(asc(collections.partNo));
  return r.map((x) => x.id);
}

export type { CollectionRow };
