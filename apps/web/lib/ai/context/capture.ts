import type { ConversationContext, EntityReference } from "./types";
import {
  recordCandidateSet,
  recordSelection,
  recordWrite,
} from "./store";

/**
 * F6 — Translate tool results into context updates.
 *
 * Called by the agent after every tool call so the context always reflects
 * the latest grounded database state. NEVER writes model-synthesised ids —
 * only uuids that the tool itself returned (which already came from a repo
 * helper, which came from the database).
 */

/** Per-turn book-keeping: every tool call this round increments turnId
 *  implicitly. We only need to know WHICH tool produced the result + its
 *  payload. */
export function captureToolResult(
  ctx: ConversationContext,
  toolName: string,
  result: unknown,
): void {
  if (!result || typeof result !== "object") return;
  const anyResult = result as Record<string, unknown>;
  if (anyResult.ok !== true) return;
  const data = (anyResult.data as Record<string, unknown> | undefined) ?? undefined;
  if (!data) return;

  if (toolName === "search_products") {
    const candidates = Array.isArray(data.candidates) ? (data.candidates as Array<Record<string, unknown>>) : [];
    if (candidates.length === 0) return;
    const refs: EntityReference[] = candidates
      .map((c) => toProductRef(c, ctx, "search_products"))
      .filter((r): r is EntityReference => r !== null);
    if (refs.length === 0) return;
    recordCandidateSet(ctx, {
      query: typeof data.query === "string" ? data.query : "",
      entityType: "product",
      candidates: refs,
      turnId: ctx.turnCount,
    });
    // If exactly one candidate was returned, that's effectively a selection.
    if (refs.length === 1) recordSelection(ctx, refs[0]!);
    return;
  }

  if (toolName === "get_product") {
    const product = data.product as Record<string, unknown> | undefined;
    if (!product) return;
    const ref = toProductRef(product, ctx, "get_product");
    if (ref) recordSelection(ctx, ref);
    return;
  }

  if (
    toolName === "preview_update_product_price" ||
    toolName === "preview_update_product_quantity"
  ) {
    // The preview result only carries a confirmation block; the product uuid
    // isn't directly in `data`. The upstream resolveProducts path captured it
    // via search_products; the preview step itself just creates a pending row
    // — no new entity reference to record.
    return;
  }

  if (toolName === "preview_create_customer") {
    // Nothing to capture; customer-create doesn't resolve an existing entity.
    return;
  }
}

/** Called by the /api/ai/confirm handler after a successful executor write.
 *  Updates the context with the VERIFIED post-write state so the next turn's
 *  snapshot reflects reality — not the stale preview value. */
export function captureWriteResult(
  ctx: ConversationContext,
  args: {
    entityType: "product" | "customer";
    entityId: string;
    displayName: string;
    branchId: string | null;
    field: "price" | "quantity" | "customer";
    before: unknown;
    after: unknown;
  },
): void {
  const ref: EntityReference = {
    entityType: args.entityType,
    entityId: args.entityId,
    displayName: args.displayName,
    branchId: args.branchId,
    turnId: ctx.turnCount,
    capturedAt: new Date().toISOString(),
    confidence: "HIGH",
    source: "write_result",
    snapshot:
      args.field === "price" && typeof args.after === "number"
        ? { price: args.after }
        : args.field === "quantity" && typeof args.after === "number"
          ? { quantity: args.after }
          : undefined,
  };
  recordSelection(ctx, ref);
  recordWrite(ctx, {
    entityRef: ref,
    field: args.field,
    before: args.before,
    after: args.after,
  });
}

function toProductRef(
  c: Record<string, unknown>,
  ctx: ConversationContext,
  source: EntityReference["source"],
): EntityReference | null {
  const entityId = typeof c.id === "string" ? c.id : null;
  const displayName = typeof c.name === "string" ? c.name : null;
  if (!entityId || !displayName) return null;
  const price = typeof c.price === "number" ? c.price : undefined;
  const quantity = typeof c.quantity === "number" ? c.quantity : undefined;
  const brand = typeof c.brand === "string" ? c.brand : null;
  const sku = typeof c.sku === "string" ? c.sku : null;
  const tierRaw = (c.confidence as { tier?: unknown } | undefined)?.tier;
  const confidence: EntityReference["confidence"] =
    tierRaw === "HIGH" || tierRaw === "MEDIUM" || tierRaw === "LOW"
      ? tierRaw
      : "HIGH"; // get_product returns HIGH by construction
  return {
    entityType: "product",
    entityId,
    displayName,
    branchId: ctx.branchId,
    turnId: ctx.turnCount,
    capturedAt: new Date().toISOString(),
    confidence,
    source,
    snapshot: { price, quantity, brand, sku },
  };
}
