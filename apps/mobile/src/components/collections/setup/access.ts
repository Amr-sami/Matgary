/**
 * Who sees what on the collections settings screens — the pure rules (doc 15
 * spec 09 §4.2; 03 §B.5, §B.14). TYPE-ONLY imports: plain Node tests it
 * (__tests__/access.test.ts); `useCollectionsAccess` binds it to the session.
 *
 *   canManage   = owner || manage_collection_accounts   (09 §4.2, verbatim;
 *                 the same rule as 08's collectionAccess().canManage)
 *   collections = features.collections                  (branch switch on)
 *   ingest      = features.collectionsIngest            (L2, M2+)
 *   autoConfirm = features.collectionsAutoConfirm
 *   available   = features.collectionsAvailable         (COLLECTIONS_ENABLED
 *                 admits the tenant, independent of the branch switch — the
 *                 owner must reach the hub to turn that switch on; no probe)
 *
 * A missing `features` object (an older server) means nothing is available.
 * The server is the authority on every gate (05 enforces
 * `manage_collection_accounts` and the staff branch rule); this only decides
 * what the UI offers.
 */
import type { MeResponse } from "@matgary/api-client";

export interface CollectionsSetupAccess {
  isOwner: boolean;
  canManage: boolean;
  collections: boolean;
  ingest: boolean;
  autoConfirm: boolean;
  available: boolean;
}

type MeLike = Pick<MeResponse, "isOwner" | "permissions" | "features"> | null | undefined;

export function collectionsSetupAccess(me: MeLike): CollectionsSetupAccess {
  const f = me?.features;
  const isOwner = Boolean(me?.isOwner);
  return {
    isOwner,
    canManage: isOwner || (me?.permissions ?? []).includes("manage_collection_accounts"),
    collections: f?.collections === true,
    ingest: f?.collectionsIngest === true,
    autoConfirm: f?.collectionsAutoConfirm === true,
    available: f?.collectionsAvailable === true,
  };
}

/** Settings tile `settings-tile-collections`: hidden unless both (no "soon" state). */
export function collectionsTileVisible(a: CollectionsSetupAccess): boolean {
  return a.canManage && a.available;
}

/**
 * The hub and the account form: what to render instead of the screen.
 * No request is made in either blocked state (the queries are disabled).
 */
export function collectionsScreenGate(a: CollectionsSetupAccess): "ok" | "noPermission" | "unavailable" {
  if (!a.canManage) return "noPermission";
  if (!a.available) return "unavailable";
  return "ok";
}

export interface BranchChoice {
  /** null = every branch of the shop. */
  id: string | null;
  name: string;
}

/**
 * The account form's branch picker (09 §4.2, §6.7): the owner gets "All
 * branches" (id null, labelled by the caller) plus each branch; a staff
 * member only their own branch. `allLabel` is the translated "All branches".
 */
export function branchChoices(
  me: Pick<MeResponse, "isOwner" | "branch" | "branches"> | null | undefined,
  allLabel: string,
): BranchChoice[] {
  if (!me) return [];
  if (me.isOwner) {
    return [{ id: null, name: allLabel }, ...me.branches.map((b) => ({ id: b.id, name: b.name }))];
  }
  return me.branch?.id ? [{ id: me.branch.id, name: me.branch.name ?? "—" }] : [];
}
