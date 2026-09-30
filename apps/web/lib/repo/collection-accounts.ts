// Digital collections — receiving accounts (05 §4.14, 03 §B.2.1).
//
// The owner's own InstaPay-reachable bank accounts and mobile wallets. Rows
// are soft-deleted only (`archived_at`): `collections.collection_account_id`
// is ON DELETE RESTRICT, so there is no hard-delete path at all.
//
// Visibility (03 §E.5): every member sees what a cashier must show the
// customer (label, provider, IPA handle/link, wallet number, masks); the full
// IBAN and the balance-chain fields only go to `manage_collection_accounts`.

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  branches,
  collectionAccounts,
  collections,
  type CollectionAccountRow,
} from "@/lib/db/schema";
import { DomainError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/api/idempotency";
import type { TenantTx } from "@/lib/collections/flags";
import { COLLECTION_PROVIDERS } from "@matgary/domain/collections/providers";
import {
  accountMask,
  normalizeIban,
  normalizeWalletMsisdn,
} from "@matgary/domain/collections/normalize";
import {
  IPA_HANDLE_RE,
  ipaHandleFromLink,
  isValidIpaLink,
} from "@matgary/domain/collections/ipa";
import type { CollectionProvider, CollectionRail } from "@matgary/domain/collections/types";

// ─────────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────────

export interface CollectionAccountDTO {
  id: string;
  branchId: string | null;
  rail: CollectionRail;
  provider: CollectionProvider;
  label: string;
  holderName: string | null;
  ipaHandle: string | null;
  ipaLink: string | null;
  accountLast4: string | null;
  isPrepaidCard: boolean;
  /** Everyone: the cashier shows it to the customer (03 §E.5). */
  walletMsisdn: string | null;
  /** Full value only with manage_collection_accounts; else null. */
  iban: string | null;
  /** Everyone (receipt mask). */
  ibanLast4: string | null;
  /** 06's ASCII accountMask(): "***1234" | "***@instapay" | "***". */
  mask: string;
  walletOpenedOn: string | null;
  isDefaultForMobile: boolean;
  isPosDefault: boolean;
  autoConfirmEnabled: boolean;
  reviewThreshold: number;
  balanceCheckEnabled: boolean;
  /** manage only; else null. */
  balanceBaseline: number | null;
  balanceBaselineAt: string | null;
  balanceChainBrokenAt: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function iso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

export function toAccountDTO(row: CollectionAccountRow, canManage: boolean): CollectionAccountDTO {
  return {
    id: row.id,
    branchId: row.branchId,
    rail: row.rail as CollectionRail,
    provider: row.provider as CollectionProvider,
    label: row.label,
    holderName: row.holderName,
    ipaHandle: row.ipaHandle,
    ipaLink: row.ipaLink,
    accountLast4: row.accountLast4,
    isPrepaidCard: row.isPrepaidCard,
    walletMsisdn: row.walletMsisdn,
    iban: canManage ? row.iban : null,
    ibanLast4: row.iban ? row.iban.slice(-4) : null,
    mask: accountMask({
      accountLast4: row.accountLast4,
      walletMsisdn: row.walletMsisdn,
      ipaHandle: row.ipaHandle,
      isPrepaidCard: row.isPrepaidCard,
    }),
    walletOpenedOn: row.walletOpenedOn,
    isDefaultForMobile: row.isDefaultForMobile,
    isPosDefault: row.isPosDefault,
    autoConfirmEnabled: row.autoConfirmEnabled,
    reviewThreshold: Number(row.reviewThreshold),
    balanceCheckEnabled: row.balanceCheckEnabled,
    balanceBaseline: canManage && row.balanceBaseline != null ? Number(row.balanceBaseline) : null,
    balanceBaselineAt: canManage ? iso(row.balanceBaselineAt) : null,
    balanceChainBrokenAt: canManage ? iso(row.balanceChainBrokenAt) : null,
    sortOrder: row.sortOrder,
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export interface ListAccountsInput {
  /** The caller's active branch. */
  activeBranchId: string;
  /** `all` is honoured only for managers (else read as `branch`). */
  scope: "branch" | "all";
  /** Honoured only for managers. */
  includeArchived: boolean;
  canManage: boolean;
  /** null = every branch (owner); else the staff allow-list. */
  accessibleBranchIds: string[] | null;
}

/**
 * GET collections/accounts. `branch` scope = the active branch's rows plus the
 * tenant-wide (`branch_id IS NULL`) ones; `all` (managers) = every branch the
 * caller can reach. Order: rail, POS default first, sort_order, label.
 */
export async function listCollectionAccounts(
  tenantId: string,
  input: ListAccountsInput,
): Promise<CollectionAccountDTO[]> {
  const all = input.canManage && input.scope === "all";
  const withArchived = input.canManage && input.includeArchived;
  return withTenant(tenantId, async (tx) => {
    const filters = [eq(collectionAccounts.tenantId, tenantId)];
    if (!withArchived) filters.push(isNull(collectionAccounts.archivedAt));
    if (!all) {
      filters.push(
        or(isNull(collectionAccounts.branchId), eq(collectionAccounts.branchId, input.activeBranchId))!,
      );
    } else if (input.accessibleBranchIds) {
      filters.push(
        input.accessibleBranchIds.length > 0
          ? or(
              isNull(collectionAccounts.branchId),
              inArray(collectionAccounts.branchId, input.accessibleBranchIds),
            )!
          : isNull(collectionAccounts.branchId),
      );
    }
    const rows = await tx
      .select()
      .from(collectionAccounts)
      .where(and(...filters))
      .orderBy(
        asc(collectionAccounts.rail),
        desc(collectionAccounts.isPosDefault),
        asc(collectionAccounts.sortOrder),
        asc(collectionAccounts.label),
      );
    return rows.map((r) => toAccountDTO(r, input.canManage));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Account resolution for collection parts (05 §4.6 table) — used by
// lib/repo/collections.ts inside the sale / settlement transaction. Never
// throws for a business reason: the sale books and the part is flagged.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedPartAccount {
  id: string;
  label: string;
  archived: boolean;
}

export interface PartAccountResolution {
  /** Accounts found for the given ids (any branch of the tenant, archived included). */
  byId: Map<string, ResolvedPartAccount>;
  /** The branch's POS default for the rail (branch row first, then a tenant-wide row). */
  posDefault: ResolvedPartAccount | null;
}

export async function resolvePartAccounts(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  rail: CollectionRail,
  ids: readonly string[],
): Promise<PartAccountResolution> {
  const byId = new Map<string, ResolvedPartAccount>();
  const unique = Array.from(new Set(ids.filter((x) => typeof x === "string" && x.length > 0)));
  if (unique.length > 0) {
    const rows = await tx
      .select({ id: collectionAccounts.id, label: collectionAccounts.label, archivedAt: collectionAccounts.archivedAt })
      .from(collectionAccounts)
      .where(and(eq(collectionAccounts.tenantId, tenantId), inArray(collectionAccounts.id, unique)));
    for (const r of rows) byId.set(r.id, { id: r.id, label: r.label, archived: r.archivedAt != null });
  }
  // The POS default only matters for the single-part case with no account
  // given (the caller passes no ids then); a split names an account per part.
  let posDefault: ResolvedPartAccount | null = null;
  if (unique.length === 0) {
    const rows = await tx
      .select({ id: collectionAccounts.id, label: collectionAccounts.label, branchId: collectionAccounts.branchId })
      .from(collectionAccounts)
      .where(
        and(
          eq(collectionAccounts.tenantId, tenantId),
          eq(collectionAccounts.rail, rail),
          eq(collectionAccounts.isPosDefault, true),
          isNull(collectionAccounts.archivedAt),
          or(eq(collectionAccounts.branchId, branchId), isNull(collectionAccounts.branchId)),
        ),
      );
    const pick = rows.find((r) => r.branchId === branchId) ?? rows.find((r) => r.branchId == null) ?? null;
    posDefault = pick ? { id: pick.id, label: pick.label, archived: false } : null;
  }
  return { byId, posDefault };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes — validation (05 §4.14)
// ─────────────────────────────────────────────────────────────────────────────

/** The zod-parsed body (shape only); semantics are checked here. `null`
 *  clears a field (the mobile form sends the other rail's fields as null). */
export interface AccountFieldsInput {
  label?: string;
  holderName?: string | null;
  branchId?: string | null;
  ipaLink?: string | null;
  ipaHandle?: string | null;
  accountLast4?: string | null;
  isPrepaidCard?: boolean | null;
  iban?: string | null;
  walletMsisdn?: string | null;
  walletOpenedOn?: string | null;
  isDefaultForMobile?: boolean | null;
  isPosDefault?: boolean | null;
  autoConfirmEnabled?: boolean | null;
  reviewThreshold?: number | null;
  balanceCheckEnabled?: boolean | null;
  sortOrder?: number | null;
}

export interface AccountCreateInput extends AccountFieldsInput {
  rail: CollectionRail;
  provider: CollectionProvider;
  label: string;
}

export interface AccountActor {
  userId: string;
  isOwner: boolean;
  /** The caller's active branch (a staff create without branchId lands here). */
  activeBranchId: string;
  /** null = every branch (owner). */
  accessibleBranchIds: string[] | null;
}

function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

type NormalisedFields = Partial<{
  label: string;
  holderName: string | null;
  ipaLink: string | null;
  ipaHandle: string | null;
  accountLast4: string | null;
  isPrepaidCard: boolean;
  iban: string | null;
  walletMsisdn: string | null;
  walletOpenedOn: string | null;
  isDefaultForMobile: boolean;
  isPosDefault: boolean;
  autoConfirmEnabled: boolean;
  reviewThreshold: string;
  balanceCheckEnabled: boolean;
  sortOrder: number;
}>;

/** Field-level semantics → column values, or a DomainError (400). */
export function normaliseAccountFields(input: AccountFieldsInput): NormalisedFields {
  const out: NormalisedFields = {};
  if (input.label !== undefined) out.label = input.label.trim();
  const holder = blankToNull(input.holderName);
  if (holder !== undefined) out.holderName = holder;

  const link = blankToNull(input.ipaLink);
  if (link !== undefined) {
    if (link !== null && !isValidIpaLink(link)) {
      throw new DomainError("INVALID_IPA_LINK", 400, { field: "ipaLink" });
    }
    out.ipaLink = link;
  }
  const handleRaw = blankToNull(input.ipaHandle);
  if (handleRaw !== undefined && handleRaw !== null) {
    const h = handleRaw.toLowerCase();
    if (!IPA_HANDLE_RE.test(h)) throw new DomainError("INVALID_IPA_LINK", 400, { field: "ipaHandle" });
    out.ipaHandle = h;
  } else if (link) {
    // Derived from the link when absent (06 ipaHandleFromLink).
    const derived = ipaHandleFromLink(link);
    if (!derived) throw new DomainError("INVALID_IPA_LINK", 400, { field: "ipaHandle" });
    out.ipaHandle = derived;
  } else if (handleRaw === null) {
    out.ipaHandle = null;
  }

  const last4 = blankToNull(input.accountLast4);
  if (last4 !== undefined) {
    if (last4 !== null && !/^\d{4}$/.test(last4)) {
      throw new DomainError("INVALID_REQUEST", 400, { path: "accountLast4", message: "must be 4 digits" });
    }
    out.accountLast4 = last4;
  }
  if (input.isPrepaidCard !== undefined) out.isPrepaidCard = !!input.isPrepaidCard;

  const iban = blankToNull(input.iban);
  if (iban !== undefined) {
    if (iban === null) out.iban = null;
    else {
      const n = normalizeIban(iban);
      if (!n) throw new DomainError("INVALID_IBAN", 400);
      out.iban = n;
    }
  }
  const msisdn = blankToNull(input.walletMsisdn);
  if (msisdn !== undefined) {
    if (msisdn === null) out.walletMsisdn = null;
    else {
      const n = normalizeWalletMsisdn(msisdn);
      if (!n) throw new DomainError("INVALID_WALLET_NUMBER", 400);
      out.walletMsisdn = n;
    }
  }
  const opened = blankToNull(input.walletOpenedOn);
  if (opened !== undefined) out.walletOpenedOn = opened;
  if (input.isDefaultForMobile != null) out.isDefaultForMobile = input.isDefaultForMobile;
  if (input.isPosDefault != null) out.isPosDefault = input.isPosDefault;
  if (input.autoConfirmEnabled != null) out.autoConfirmEnabled = input.autoConfirmEnabled;
  if (input.reviewThreshold != null) out.reviewThreshold = Number(input.reviewThreshold).toFixed(2);
  if (input.balanceCheckEnabled != null) out.balanceCheckEnabled = input.balanceCheckEnabled;
  if (input.sortOrder != null) out.sortOrder = input.sortOrder;
  return out;
}

/** Mirrors `collection_accounts_identity_chk`. */
function hasIdentity(a: {
  walletMsisdn?: string | null;
  ipaHandle?: string | null;
  ipaLink?: string | null;
  accountLast4?: string | null;
  iban?: string | null;
  isPrepaidCard?: boolean | null;
}): boolean {
  return !!(a.walletMsisdn || a.ipaHandle || a.ipaLink || a.accountLast4 || a.iban || a.isPrepaidCard);
}

/**
 * The branch an account may be written with. Owner: any branch of the
 * tenant, or null (every branch); omitted = null. Staff: only a branch on
 * their allow-list; omitted = their active branch; null (tenant-wide) is an
 * owner decision → 403 FORBIDDEN_BRANCH. Unknown branch → 400 INVALID_BRANCH.
 */
async function resolveAccountBranch(
  tx: TenantTx,
  tenantId: string,
  actor: AccountActor,
  requested: string | null | undefined,
): Promise<string | null> {
  if (requested === undefined) return actor.isOwner ? null : actor.activeBranchId;
  if (requested === null) {
    if (!actor.isOwner) throw new DomainError("FORBIDDEN_BRANCH", 403);
    return null;
  }
  if (actor.accessibleBranchIds && !actor.accessibleBranchIds.includes(requested)) {
    throw new DomainError("FORBIDDEN_BRANCH", 403);
  }
  const [b] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.id, requested)))
    .limit(1);
  if (!b) throw new DomainError("INVALID_BRANCH", 400, { branchId: requested });
  return requested;
}

/** Only one POS default per (tenant, branch-or-NULL, rail) among live rows
 *  (`collection_accounts_pos_default_uq`): setting it clears the others in
 *  the same transaction instead of failing. */
async function clearOtherPosDefault(
  tx: TenantTx,
  tenantId: string,
  branchId: string | null,
  rail: string,
  selfId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE collection_accounts
       SET is_pos_default = false, updated_at = now()
     WHERE tenant_id = ${tenantId}
       AND rail = ${rail}
       AND is_pos_default
       AND archived_at IS NULL
       AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(${branchId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       ${selfId ? sql`AND id <> ${selfId}` : sql``}
  `);
}

/** InstaPay transfers to the owner's mobile number land in ONE default bank
 *  account (instapay.md §2): setting the flag clears it on the tenant's other
 *  instapay accounts. */
async function clearOtherMobileDefault(tx: TenantTx, tenantId: string, selfId: string | null): Promise<void> {
  await tx.execute(sql`
    UPDATE collection_accounts
       SET is_default_for_mobile = false, updated_at = now()
     WHERE tenant_id = ${tenantId}
       AND rail = 'instapay'
       AND is_default_for_mobile
       ${selfId ? sql`AND id <> ${selfId}` : sql``}
  `);
}

function mapDuplicate(err: unknown): never {
  if (
    isUniqueViolation(err, "collection_accounts_tenant_msisdn_uq") ||
    isUniqueViolation(err, "collection_accounts_tenant_provider_last4_uq")
  ) {
    throw new DomainError("COLLECTION_ACCOUNT_DUPLICATE", 409);
  }
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export async function createCollectionAccount(
  tenantId: string,
  actor: AccountActor,
  input: AccountCreateInput,
): Promise<CollectionAccountDTO> {
  const info = COLLECTION_PROVIDERS[input.provider];
  if (!info || info.rail !== input.rail) {
    throw new DomainError("PROVIDER_RAIL_MISMATCH", 400, { rail: input.rail, provider: input.provider });
  }
  const f = normaliseAccountFields(input);
  if (!hasIdentity(f)) throw new DomainError("ACCOUNT_IDENTITY_REQUIRED", 400);
  try {
    return await withTenant(tenantId, async (tx) => {
      const branchId = await resolveAccountBranch(tx, tenantId, actor, input.branchId);
      if (f.isPosDefault) await clearOtherPosDefault(tx, tenantId, branchId, input.rail, null);
      if (f.isDefaultForMobile && input.rail === "instapay") await clearOtherMobileDefault(tx, tenantId, null);
      const [row] = await tx
        .insert(collectionAccounts)
        .values({
          tenantId,
          branchId,
          rail: input.rail,
          provider: input.provider,
          label: f.label ?? input.label.trim(),
          holderName: f.holderName ?? null,
          ipaHandle: f.ipaHandle ?? null,
          ipaLink: f.ipaLink ?? null,
          accountLast4: f.accountLast4 ?? null,
          isPrepaidCard: f.isPrepaidCard ?? false,
          iban: f.iban ?? null,
          walletMsisdn: f.walletMsisdn ?? null,
          walletOpenedOn: f.walletOpenedOn ?? null,
          isDefaultForMobile: f.isDefaultForMobile ?? false,
          isPosDefault: f.isPosDefault ?? false,
          autoConfirmEnabled: f.autoConfirmEnabled ?? false,
          ...(f.reviewThreshold != null ? { reviewThreshold: f.reviewThreshold } : {}),
          balanceCheckEnabled: f.balanceCheckEnabled ?? true,
          sortOrder: f.sortOrder ?? 0,
          createdByUserId: actor.userId,
        })
        .returning();
      return toAccountDTO(row!, true);
    });
  } catch (err) {
    mapDuplicate(err);
  }
}

/** Loads a live account the caller may touch, FOR UPDATE; archived, foreign
 *  or out-of-reach → 404 COLLECTION_ACCOUNT_NOT_FOUND. */
async function loadWritableAccount(
  tx: TenantTx,
  tenantId: string,
  actor: AccountActor,
  id: string,
): Promise<CollectionAccountRow> {
  const [row] = await tx
    .select()
    .from(collectionAccounts)
    .where(and(eq(collectionAccounts.tenantId, tenantId), eq(collectionAccounts.id, id)))
    .limit(1)
    .for("update");
  if (!row || row.archivedAt) throw new DomainError("COLLECTION_ACCOUNT_NOT_FOUND", 404);
  if (row.branchId && actor.accessibleBranchIds && !actor.accessibleBranchIds.includes(row.branchId)) {
    throw new DomainError("COLLECTION_ACCOUNT_NOT_FOUND", 404);
  }
  return row;
}

export async function updateCollectionAccount(
  tenantId: string,
  actor: AccountActor,
  id: string,
  input: AccountFieldsInput,
): Promise<{ dto: CollectionAccountDTO; changed: string[] }> {
  const f = normaliseAccountFields(input);
  try {
    return await withTenant(tenantId, async (tx) => {
      const row = await loadWritableAccount(tx, tenantId, actor, id);
      const branchId =
        input.branchId === undefined ? row.branchId : await resolveAccountBranch(tx, tenantId, actor, input.branchId);
      const merged = {
        walletMsisdn: f.walletMsisdn !== undefined ? f.walletMsisdn : row.walletMsisdn,
        ipaHandle: f.ipaHandle !== undefined ? f.ipaHandle : row.ipaHandle,
        ipaLink: f.ipaLink !== undefined ? f.ipaLink : row.ipaLink,
        accountLast4: f.accountLast4 !== undefined ? f.accountLast4 : row.accountLast4,
        iban: f.iban !== undefined ? f.iban : row.iban,
        isPrepaidCard: f.isPrepaidCard !== undefined ? f.isPrepaidCard : row.isPrepaidCard,
      };
      if (!hasIdentity(merged)) throw new DomainError("ACCOUNT_IDENTITY_REQUIRED", 400);

      const set: Record<string, unknown> = {};
      const changed: string[] = [];
      const assign = (key: keyof CollectionAccountRow, value: unknown) => {
        const before = row[key];
        const same =
          before instanceof Date || value instanceof Date
            ? String(before) === String(value)
            : before === value;
        if (!same) {
          set[key] = value;
          changed.push(key);
        }
      };
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined) continue;
        assign(k as keyof CollectionAccountRow, v);
      }
      if (branchId !== row.branchId) assign("branchId", branchId);
      // The identity changed: 07's balance chain must restart from a new,
      // human- or credit-approved baseline (03 §C.8 step 4).
      if (changed.includes("walletMsisdn") || changed.includes("accountLast4")) {
        set.balanceBaseline = null;
        set.balanceBaselineAt = null;
        set.balanceChainBrokenAt = sql`now()`;
      }
      const finalPos = (set.isPosDefault as boolean | undefined) ?? row.isPosDefault;
      if (finalPos && (changed.includes("isPosDefault") || changed.includes("branchId"))) {
        await clearOtherPosDefault(tx, tenantId, branchId, row.rail, row.id);
      }
      if (set.isDefaultForMobile === true && row.rail === "instapay") {
        await clearOtherMobileDefault(tx, tenantId, row.id);
      }
      if (Object.keys(set).length === 0) return { dto: toAccountDTO(row, true), changed };
      set.updatedAt = sql`now()`;
      const [updated] = await tx
        .update(collectionAccounts)
        .set(set)
        .where(and(eq(collectionAccounts.tenantId, tenantId), eq(collectionAccounts.id, id)))
        .returning();
      return { dto: toAccountDTO(updated!, true), changed };
    });
  } catch (err) {
    mapDuplicate(err);
  }
}

/** DELETE = archive. Pending collections keep pointing at the account. */
export async function archiveCollectionAccount(
  tenantId: string,
  actor: AccountActor,
  id: string,
): Promise<{ archived: true; pendingCollections: number; label: string; accountLast4: string | null }> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadWritableAccount(tx, tenantId, actor, id);
    await tx
      .update(collectionAccounts)
      .set({ archivedAt: sql`now()`, isPosDefault: false, updatedAt: sql`now()` })
      .where(and(eq(collectionAccounts.tenantId, tenantId), eq(collectionAccounts.id, id)));
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(collections)
      .where(
        and(
          eq(collections.tenantId, tenantId),
          eq(collections.collectionAccountId, id),
          eq(collections.status, "pending"),
        ),
      );
    return {
      archived: true as const,
      pendingCollections: Number(n ?? 0),
      label: row.label,
      accountLast4: row.accountLast4 ?? (row.iban ? row.iban.slice(-4) : null),
    };
  });
}

/** Activity metadata for an account: never the IBAN digits (last 4 only). */
export function accountActivityMetadata(dto: CollectionAccountDTO): Record<string, unknown> {
  return {
    rail: dto.rail,
    provider: dto.provider,
    branchId: dto.branchId,
    mask: dto.mask,
    ibanLast4: dto.ibanLast4,
    isPosDefault: dto.isPosDefault,
  };
}

