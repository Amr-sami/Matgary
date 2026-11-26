import { cacheDel, cacheGet, cacheSet, tenantKey } from "@/lib/cache";

import type { Locale } from "../responses";

import {
  CONTEXT_MAX_CANDIDATES,
  CONTEXT_MAX_RECENT_WRITES,
  CONTEXT_TTL_SEC,
  type CandidateSet,
  type ConversationContext,
  type EntityReference,
} from "./types";

/**
 * F6 — Conversation context Redis store.
 *
 * Key shape: `matgary:…:t:{tenantId}:ai:ctx:{conversationId}`.
 * The `tenantId` prefix means a Redis scan across tenants would still partition;
 * a lookup against a wrong tenantId simply returns null (no cross-tenant leak).
 *
 * Degradation: `cacheGet` returns null when Redis is unavailable (the project
 * uses an optional Redis layer). The agent treats null context as "no history"
 * and still works — the model loses follow-up resolution, but that's safe.
 */

const PREFIX = "ai:ctx";

function key(tenantId: string, conversationId: string): string {
  return tenantKey(tenantId, PREFIX, conversationId);
}

export interface LoadInput {
  tenantId: string;
  conversationId: string;
}

export async function loadContext(input: LoadInput): Promise<ConversationContext | null> {
  const raw = await cacheGet<ConversationContext>(key(input.tenantId, input.conversationId));
  if (!raw) return null;
  // Belt-and-braces tenant check: a shared-cache key collision would be caught
  // here before the context is handed to tools.
  if (raw.tenantId !== input.tenantId) return null;
  return raw;
}

export interface CreateInput {
  tenantId: string;
  userId: string;
  conversationId: string;
  branchId: string | null;
  locale: Locale;
}

/** Produce a fresh empty context — called when no stored row is found. */
export function makeEmptyContext(input: CreateInput): ConversationContext {
  const now = new Date().toISOString();
  return {
    conversationId: input.conversationId,
    tenantId: input.tenantId,
    userId: input.userId,
    branchId: input.branchId,
    locale: input.locale,
    turnCount: 0,
    lastCandidateSet: null,
    selectedEntity: null,
    recentWrites: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveContext(ctx: ConversationContext): Promise<void> {
  ctx.updatedAt = new Date().toISOString();
  await cacheSet(key(ctx.tenantId, ctx.conversationId), ctx, CONTEXT_TTL_SEC);
}

export async function clearContext(input: LoadInput): Promise<void> {
  await cacheDel(key(input.tenantId, input.conversationId));
}

/* ───────────────────────────── mutations ──────────────────────────────── */

/** Record a new candidate set from a search_products turn. REPLACES the prior
 *  set (a new search always resets "the second one" to the new result list). */
export function recordCandidateSet(
  ctx: ConversationContext,
  set: Omit<CandidateSet, "capturedAt">,
): void {
  const trimmed = {
    ...set,
    candidates: set.candidates.slice(0, CONTEXT_MAX_CANDIDATES),
    capturedAt: new Date().toISOString(),
  };
  ctx.lastCandidateSet = trimmed;
  // A new search blurs the "selected" entity unless it's still present in the
  // new set — the user may have moved on.
  if (ctx.selectedEntity && !trimmed.candidates.some((c) => c.entityId === ctx.selectedEntity!.entityId)) {
    ctx.selectedEntity = null;
  }
}

/** Mark a specific entity as "the one we're talking about now". Called when
 *  a confirmation is staged, OR when the user explicitly focuses one. */
export function recordSelection(
  ctx: ConversationContext,
  entity: EntityReference,
): void {
  ctx.selectedEntity = entity;
  // Keep the candidate set but mark that we've narrowed in; the resolver
  // prefers selectedEntity over lastCandidateSet when both are present.
}

/** Record a successful write + update the entity snapshot to the verified
 *  post-write state. Powers "actually make it 2700". */
export function recordWrite(
  ctx: ConversationContext,
  args: {
    entityRef: EntityReference;
    field: "price" | "quantity" | "customer";
    before?: unknown;
    after?: unknown;
  },
): void {
  const entry = {
    entityRef: args.entityRef,
    field: args.field,
    before: args.before,
    after: args.after,
    turnId: ctx.turnCount,
    at: new Date().toISOString(),
  };
  ctx.recentWrites = [entry, ...ctx.recentWrites].slice(0, CONTEXT_MAX_RECENT_WRITES);

  // Update the live snapshot on lastCandidateSet + selectedEntity so stale
  // prices never resurface.
  const patchSnapshot = (ref: EntityReference) => {
    if (ref.entityId !== args.entityRef.entityId) return;
    if (args.field === "price" && typeof args.after === "number") {
      ref.snapshot = { ...(ref.snapshot ?? {}), price: args.after };
    }
    if (args.field === "quantity" && typeof args.after === "number") {
      ref.snapshot = { ...(ref.snapshot ?? {}), quantity: args.after };
    }
  };
  if (ctx.lastCandidateSet) ctx.lastCandidateSet.candidates.forEach(patchSnapshot);
  if (ctx.selectedEntity) patchSnapshot(ctx.selectedEntity);
}

/** Bump turn counter at the start of each round. */
export function bumpTurn(ctx: ConversationContext): void {
  ctx.turnCount += 1;
}
