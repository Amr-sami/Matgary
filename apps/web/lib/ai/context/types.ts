import type { Locale } from "../responses";

/**
 * F6 — Server-side conversation context.
 *
 * Purpose: give the agent a durable, tenant-safe memory of recent entity
 * references so that natural follow-ups like "the second one" or "its price"
 * resolve to REAL database uuids before any F5 write touches them.
 *
 * Non-goals:
 *   • Not a RAG system.
 *   • Not an embedding store.
 *   • Not a personality / long-term user memory.
 *
 * Isolation: every lookup is scoped by `tenantId`. A context reference from
 * tenant A can NEVER resolve into tenant B — the store key itself embeds the
 * tenantId and every function in `store.ts` requires it on the input.
 *
 * The `branchId` is ALSO part of the context: entity references captured in
 * branch A are tagged with that branch, and the resolver refuses to apply
 * them when the user's current active branch is different.
 */

export type EntityType = "product" | "customer";

export interface EntityReference {
  entityType: EntityType;
  /** Real database uuid or composite key — source-of-truth from a tool. */
  entityId: string;
  /** What the user saw for this entity in UI. Never model-synthesised. */
  displayName: string;
  /** Snapshot of the field a write may target — the resolver uses this to
   *  format clarifications ("Musk Rumman — 2,200 EGP, qty 2"). */
  snapshot?: {
    price?: number;
    quantity?: number;
    brand?: string | null;
    sku?: string | null;
  };
  /** Which branch this reference was captured in. Resolver refuses when the
   *  current branch differs. */
  branchId: string | null;
  /** Which turn (ordinal in the conversation) this reference was captured in. */
  turnId: number;
  /** ISO timestamp. */
  capturedAt: string;
  /** Resolver HIGH confidence only ever propagates into write flows. */
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Audit trail — which tool populated it ("search_products", etc.). */
  source:
    | "search_products"
    | "get_product"
    | "preview_update_product_price"
    | "preview_update_product_quantity"
    | "preview_create_customer"
    | "write_result";
}

/** A ranked set the user may be referring to by position ("the second one"). */
export interface CandidateSet {
  /** Normalised user query that produced this set. */
  query: string;
  entityType: EntityType;
  /** In display order — index 0 = "first", index 1 = "second", etc. */
  candidates: EntityReference[];
  turnId: number;
  capturedAt: string;
}

export interface ConversationContext {
  conversationId: string;
  tenantId: string;
  userId: string;
  /** Captured at creation; the resolver re-checks against the LIVE branch on
   *  each turn so a branch switch invalidates cross-branch references. */
  branchId: string | null;
  locale: Locale;
  /** Monotonically increasing per turn — used to age out stale references. */
  turnCount: number;
  /** The most recent product/customer list the user saw. "Second one" resolves
   *  against candidates[1]. Holds exactly one set at a time; a new search
   *  replaces it. */
  lastCandidateSet: CandidateSet | null;
  /** The entity the user is currently focused on — set when they click into
   *  / name a specific product. "its price" resolves to this. */
  selectedEntity: EntityReference | null;
  /** Recent successful writes, newest first. Powers "actually make it 2700"
   *  (current verified price comes from here). Capped. */
  recentWrites: Array<{
    entityRef: EntityReference;
    field: "price" | "quantity" | "customer";
    before?: unknown;
    after?: unknown;
    turnId: number;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Tunables. */
export const CONTEXT_TTL_SEC = 30 * 60; // 30 min
export const CONTEXT_MAX_CANDIDATES = 10;
export const CONTEXT_MAX_RECENT_WRITES = 5;
/** Beyond this many turns since capture, a candidate set / selected entity
 *  is considered stale and the resolver refuses silent resolution. Explicit
 *  references ("the Musk Rumman product") still work via normal search. */
export const CONTEXT_REFERENCE_STALE_TURNS = 5;
