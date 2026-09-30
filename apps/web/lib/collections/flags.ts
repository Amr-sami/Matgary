// Digital collections (InstaPay + mobile wallets) — feature gates.
// mobile-dev-docs/15-digital-collections/03-architecture.md §B.13 / §B.14,
// 05-server-api-and-permissions.md §4.2.
//
// Two layers decide whether a tenant sees the feature:
//   1. env gates (off | pilot | on), read on EVERY call — a redeploy flips
//      them, so nothing here is cached at module level;
//   2. the per-branch switches in shop_settings (collections_enabled,
//      collections_auto_confirm_enabled), one PK read, no cache.
//
// Truth table (03 §B.14):
//   collections            = admitted(COLLECTIONS_ENABLED) && collections_enabled
//   collectionsIngest      = collections && admitted(COLLECTIONS_INGEST_ENABLED, ingest list)
//   collectionsAutoConfirm = collectionsIngest && collections_auto_confirm_enabled
//                            && admitted(COLLECTIONS_AUTO_CONFIRM_ENABLED)   (unset/empty → on)
//   collectionsProviders   = admitted(COLLECTIONS_PROVIDERS_ENABLED)
//   collectionsAvailable   = admitted(COLLECTIONS_ENABLED)  (ignores the branch switch)

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { shopSettings } from "@/lib/db/schema";

/** The transaction handle `withTenant` hands its callback (shared by the
 *  collections repos, so the cart path can resolve flags inside its tx). */
export type TenantTx = Parameters<Parameters<typeof withTenant>[1]>[0];

export type GateMode = "off" | "pilot" | "on";

export interface CollectionsFeatures {
  collections: boolean;
  collectionsIngest: boolean;
  collectionsAutoConfirm: boolean;
  collectionsProviders: boolean;
  /** = collectionsTenantAdmitted(tenantId); ignores the branch switch (03 §B.14). */
  collectionsAvailable: boolean;
}

/** Every flag false: the safe default (a missing `features` object on an old
 *  server reads the same way on the clients, 05 §8 R10). */
export const NO_COLLECTIONS_FEATURES: Readonly<CollectionsFeatures> = Object.freeze({
  collections: false,
  collectionsIngest: false,
  collectionsAutoConfirm: false,
  collectionsProviders: false,
  collectionsAvailable: false,
});

/**
 * Minimum ingest-device consent version (03 §B.15, Q14). An ingest from a
 * device whose `consent_version` sorts below it answers 403 INGEST_DISABLED
 * with detail "consent_outdated" (07); 14 raises it for a material consent
 * change.
 */
export const COLLECTIONS_CONSENT_MIN_VERSION = "2026-10-01";

/** trim + lower-case; anything but off | pilot | on (incl. unset) → "off". */
export function gateMode(raw: string | undefined): GateMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "on" || v === "pilot" ? v : "off";
}

function parseIdList(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim().toLowerCase();
    if (id) out.add(id);
  }
  return out;
}

/** COLLECTIONS_PILOT_TENANT_IDS: comma list, trimmed, lower-cased. Shared by
 *  every gate unless a gate has its own list. */
export function pilotTenantIds(): Set<string> {
  return parseIdList(process.env.COLLECTIONS_PILOT_TENANT_IDS);
}

/** COLLECTIONS_INGEST_PILOT_TENANT_IDS, same parsing; unset or empty → the
 *  shared list (14 D14-4 cuts the L2 pilot to QA tenants with it). */
export function ingestPilotTenantIds(): Set<string> {
  const own = parseIdList(process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS);
  return own.size > 0 ? own : pilotTenantIds();
}

/** on → true · pilot → the tenant is in `list` · off → false. */
export function tenantAdmitted(
  mode: GateMode,
  tenantId: string,
  list: Set<string> = pilotTenantIds(),
): boolean {
  if (mode === "on") return true;
  if (mode === "pilot") return list.has(tenantId.trim().toLowerCase());
  return false;
}

/** COLLECTIONS_ENABLED admits the tenant (the L1 route gate). */
export function collectionsTenantAdmitted(tenantId: string): boolean {
  return tenantAdmitted(gateMode(process.env.COLLECTIONS_ENABLED), tenantId);
}

/** The only gate whose unset (or empty) value is "on": auto-confirm already
 *  sits behind ingest + the branch switch + each account's opt-in (03 §B.13). */
function autoConfirmGateMode(): GateMode {
  const raw = process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED;
  if (raw === undefined || raw.trim() === "") return "on";
  return gateMode(raw);
}

/** The per-branch switches `resolveCollectionsFeatures` reads. A missing
 *  shop_settings row reads as both false. */
export interface CollectionsBranchSwitches {
  collectionsEnabled: boolean;
  collectionsAutoConfirmEnabled: boolean;
}

/** Pure: the truth table above, given the env (read now) and the switches. */
export function computeCollectionsFeatures(
  tenantId: string,
  switches: CollectionsBranchSwitches | null,
): CollectionsFeatures {
  const available = collectionsTenantAdmitted(tenantId);
  const collections = available && !!switches?.collectionsEnabled;
  const collectionsIngest =
    collections &&
    tenantAdmitted(gateMode(process.env.COLLECTIONS_INGEST_ENABLED), tenantId, ingestPilotTenantIds());
  const collectionsAutoConfirm =
    collectionsIngest &&
    !!switches?.collectionsAutoConfirmEnabled &&
    tenantAdmitted(autoConfirmGateMode(), tenantId);
  const collectionsProviders = tenantAdmitted(
    gateMode(process.env.COLLECTIONS_PROVIDERS_ENABLED),
    tenantId,
  );
  return {
    collections,
    collectionsIngest,
    collectionsAutoConfirm,
    collectionsProviders,
    collectionsAvailable: available,
  };
}

async function readBranchSwitches(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
): Promise<CollectionsBranchSwitches | null> {
  const rows = await tx
    .select({
      collectionsEnabled: shopSettings.collectionsEnabled,
      collectionsAutoConfirmEnabled: shopSettings.collectionsAutoConfirmEnabled,
    })
    .from(shopSettings)
    .where(and(eq(shopSettings.tenantId, tenantId), eq(shopSettings.branchId, branchId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The five flags for (tenant, branch) — `features` on GET /api/v1/me and
 * GET /api/collections/config, and the cart / settle gate. Reads the branch
 * switches inside `tx` when given (the cart path), else in its own
 * `withTenant`. When COLLECTIONS_ENABLED does not admit the tenant the
 * switches cannot change the answer, so no query runs at all (the cart path
 * costs nothing while the feature is off).
 */
export async function resolveCollectionsFeatures(
  tenantId: string,
  branchId: string,
  tx?: TenantTx,
): Promise<CollectionsFeatures> {
  if (!collectionsTenantAdmitted(tenantId)) {
    return computeCollectionsFeatures(tenantId, null);
  }
  const switches = tx
    ? await readBranchSwitches(tx, tenantId, branchId)
    : await withTenant(tenantId, (t) => readBranchSwitches(t, tenantId, branchId));
  return computeCollectionsFeatures(tenantId, switches);
}

/**
 * Route gate for every /api/collections/* handler except `config`: 403
 * {error:"COLLECTIONS_DISABLED"} when COLLECTIONS_ENABLED does not admit the
 * tenant, else null. The branch switch is deliberately NOT checked, so an
 * owner can set up accounts before turning the branch on and pending items
 * stay decidable after it is turned off (05 §4.2).
 */
export function requireCollectionsTenant(tenantId: string): NextResponse | null {
  if (collectionsTenantAdmitted(tenantId)) return null;
  return NextResponse.json({ error: "COLLECTIONS_DISABLED" }, { status: 403 });
}
