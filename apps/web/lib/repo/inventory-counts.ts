// Inventory Count (جرد) repository.
//
// Scope / Non-goals
// ─────────────────
// Storo has NO branches. Every query is tenant-scoped; no branch column exists
// on inventory_counts, inventory_count_lines, or inventory_count_reconciliations.
//
// Reconciliation algorithm — the one the owner approved
// ─────────────────────────────────────────────────────
// For each counted line at confirm time:
//   movement_after_count = SUM(product_history.delta WHERE created_at > counted_at)
//   expected_physical    = counted_qty + movement_after_count
//   adjustment           = expected_physical - current_qty_at_confirm
// Applied via `_applyAdjustment(tx, …)` from catalog.ts — the SAME path a
// manual stock adjust goes through, so counts share one ledger (product_history)
// with sales, receives, returns, and manual adjustments.
//
// Lock order
// ──────────
// 1. Row-lock the count row (`SELECT … FOR UPDATE`) — serializes against
//    concurrent confirms + line edits on the same count.
// 2. For each line, row-lock the product row via _applyAdjustment's own
//    `SELECT … FOR UPDATE`, guaranteeing the SUM-after-counted_at and the
//    UPDATE to products.quantity see the same snapshot and the next writer
//    (sale, receive) blocks until we commit.

import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  inventoryCountLines,
  inventoryCountReconciliations,
  inventoryCounts,
  productHistory,
  products,
  categories,
} from "@/lib/db/schema";
import type {
  InventoryCountLineRow,
  InventoryCountReconciliationRow,
  InventoryCountRow,
} from "@/lib/db/schema";
import { _applyAdjustment } from "@/lib/repo/catalog";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CountScopeKind = "all" | "category" | "brand";
export type CountStatus = "draft" | "in_progress" | "review" | "completed" | "cancelled";
export type CountLineSource = "scan" | "manual";

export interface CountScope {
  kind: CountScopeKind;
  /** categoryId for 'category', brand text for 'brand', null for 'all'. */
  value: string | null;
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

export interface CountWithSummary {
  count: InventoryCountRow;
  summary: CountSummary;
}

export interface LineWithProduct extends InventoryCountLineRow {
  productName: string | null;
  productSku: string | null;
  categoryId: string | null;
  brand: string | null;
  productDeleted: boolean;
  /** Current live quantity — fresh at read time; useful in the UI. */
  productCurrentQty: number | null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class InventoryCountConflictError extends Error {
  constructor(
    public readonly code:
      | "COUNT_NOT_FOUND"
      | "INVALID_STATUS"
      | "ALREADY_CONFIRMED"
      | "OUT_OF_SCOPE"
      | "COUNT_HAS_INVALID_LINES",
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

// ─── Scope predicate ─────────────────────────────────────────────────────────

function scopePredicate(tenantId: string, scope: CountScope) {
  const base = eq(products.tenantId, tenantId);
  switch (scope.kind) {
    case "all":
      return base;
    case "category":
      return and(base, eq(products.categoryId, scope.value ?? ""));
    case "brand":
      return and(base, eq(products.brand, scope.value ?? ""));
  }
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a draft count AND freeze the scope: one bulk insert copies the
 * current product quantity of every product in scope into
 * `inventory_count_lines.baseline_qty`. Lines start with `counted_qty = NULL`
 * and fill in as the shopkeeper works.
 */
export async function createCount(
  tenantId: string,
  input: { scope: CountScope; createdByUserId: string },
): Promise<{ countId: string; scopeProductCount: number }> {
  return withTenant(tenantId, async (tx) => {
    // Validate scope target exists (prevents silent empty-scope counts).
    if (input.scope.kind === "category" && input.scope.value) {
      const [cat] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.tenantId, tenantId), eq(categories.id, input.scope.value)))
        .limit(1);
      if (!cat) throw new InventoryCountConflictError("COUNT_NOT_FOUND", { reason: "category_missing" });
    }

    const [count] = await tx
      .insert(inventoryCounts)
      .values({
        tenantId,
        scopeKind: input.scope.kind,
        scopeValue: input.scope.value,
        status: "draft",
        createdByUserId: input.createdByUserId,
      })
      .returning();
    if (!count) throw new Error("INSERT_COUNT_FAILED");

    // Bulk baseline insert: one SQL for the whole scope, no app-side loop.
    const inserted = await tx.execute(sql`
      INSERT INTO inventory_count_lines (count_id, tenant_id, product_id, baseline_qty)
      SELECT ${count.id}, ${tenantId}, p.id, p.quantity
      FROM products p
      WHERE p.tenant_id = ${tenantId}
        ${
          input.scope.kind === "category"
            ? sql`AND p.category_id = ${input.scope.value}`
            : input.scope.kind === "brand"
              ? sql`AND p.brand = ${input.scope.value}`
              : sql``
        }
      RETURNING id
    `);
    const scopeProductCount = Array.isArray(inserted)
      ? inserted.length
      : // pg driver returns { rows: [...] }
        (inserted as unknown as { rows: unknown[] }).rows?.length ?? 0;

    await tx
      .update(inventoryCounts)
      .set({ scopeProductCount })
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, count.id)));

    return { countId: count.id, scopeProductCount };
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listCounts(
  tenantId: string,
  opts: { status?: CountStatus | "active"; limit?: number } = {},
): Promise<CountWithSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return withTenant(tenantId, async (tx) => {
    let statusFilter;
    if (opts.status === "active") {
      statusFilter = inArray(inventoryCounts.status, ["draft", "in_progress", "review"]);
    } else if (opts.status) {
      statusFilter = eq(inventoryCounts.status, opts.status);
    }

    const rows = await tx
      .select()
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), statusFilter ?? sql`true`))
      .orderBy(sql`${inventoryCounts.createdAt} DESC`)
      .limit(limit);

    // Compute summary for each count — one query per count, bounded by `limit`.
    const summaries = await Promise.all(rows.map((r) => summaryFor(tx, tenantId, r.id)));
    return rows.map((count, i) => ({ count, summary: summaries[i] }));
  });
}

export async function getCount(
  tenantId: string,
  countId: string,
): Promise<{ count: InventoryCountRow; summary: CountSummary; lines: LineWithProduct[] } | null> {
  return withTenant(tenantId, async (tx) => {
    const [count] = await tx
      .select()
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)))
      .limit(1);
    if (!count) return null;

    const lines = await tx
      .select({
        id: inventoryCountLines.id,
        countId: inventoryCountLines.countId,
        tenantId: inventoryCountLines.tenantId,
        productId: inventoryCountLines.productId,
        baselineQty: inventoryCountLines.baselineQty,
        countedQty: inventoryCountLines.countedQty,
        countedAt: inventoryCountLines.countedAt,
        countedByUserId: inventoryCountLines.countedByUserId,
        source: inventoryCountLines.source,
        addedMidCount: inventoryCountLines.addedMidCount,
        productMissingAtConfirm: inventoryCountLines.productMissingAtConfirm,
        createdAt: inventoryCountLines.createdAt,
        productName: products.name,
        productSku: products.sku,
        categoryId: products.categoryId,
        brand: products.brand,
        productCurrentQty: products.quantity,
      })
      .from(inventoryCountLines)
      .leftJoin(products, eq(products.id, inventoryCountLines.productId))
      .where(eq(inventoryCountLines.countId, countId))
      .orderBy(sql`
        CASE
          WHEN ${inventoryCountLines.countedQty} IS NULL THEN 2
          WHEN ${inventoryCountLines.countedQty} = ${inventoryCountLines.baselineQty} THEN 1
          ELSE 0
        END,
        ${inventoryCountLines.createdAt} DESC
      `);

    const linesWithProduct: LineWithProduct[] = lines.map((l) => ({
      id: l.id,
      countId: l.countId,
      tenantId: l.tenantId,
      productId: l.productId,
      baselineQty: l.baselineQty,
      countedQty: l.countedQty,
      countedAt: l.countedAt,
      countedByUserId: l.countedByUserId,
      source: l.source,
      addedMidCount: l.addedMidCount,
      productMissingAtConfirm: l.productMissingAtConfirm,
      createdAt: l.createdAt,
      productName: l.productName ?? null,
      productSku: l.productSku ?? null,
      categoryId: l.categoryId ?? null,
      brand: l.brand ?? null,
      productCurrentQty: l.productCurrentQty ?? null,
      productDeleted: l.productName === null,
    }));

    const summary = await summaryFor(tx, tenantId, countId);
    return { count, summary, lines: linesWithProduct };
  });
}

async function summaryFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  countId: string,
): Promise<CountSummary> {
  type Row = {
    scope_product_count: number | string | null;
    lines_counted: number | string;
    lines_matched: number | string;
    lines_shortage: number | string;
    lines_overage: number | string;
    added_mid_count: number | string;
    net_adjustment: number | string;
  };
  const rows = (await tx.execute(sql`
    SELECT
      (SELECT scope_product_count FROM inventory_counts WHERE id = ${countId} AND tenant_id = ${tenantId}) AS scope_product_count,
      COUNT(*) FILTER (WHERE counted_qty IS NOT NULL) AS lines_counted,
      COUNT(*) FILTER (WHERE counted_qty IS NOT NULL AND counted_qty = baseline_qty) AS lines_matched,
      COUNT(*) FILTER (WHERE counted_qty IS NOT NULL AND counted_qty <  baseline_qty) AS lines_shortage,
      COUNT(*) FILTER (WHERE counted_qty IS NOT NULL AND counted_qty >  baseline_qty) AS lines_overage,
      COUNT(*) FILTER (WHERE added_mid_count) AS added_mid_count,
      COALESCE(SUM(counted_qty - baseline_qty) FILTER (WHERE counted_qty IS NOT NULL), 0) AS net_adjustment
    FROM inventory_count_lines
    WHERE count_id = ${countId}
  `)) as unknown as Row[];
  const r = rows[0];
  const n = (v: unknown) => Number(v ?? 0);
  return {
    scopeProductCount: n(r?.scope_product_count),
    linesCounted: n(r?.lines_counted),
    linesMatched: n(r?.lines_matched),
    linesShortage: n(r?.lines_shortage),
    linesOverage: n(r?.lines_overage),
    addedMidCount: n(r?.added_mid_count),
    netAdjustment: n(r?.net_adjustment),
  };
}

// ─── Line upsert / delete ────────────────────────────────────────────────────

/**
 * Upsert the counted value for one product.
 *
 * - If a baseline line exists for this (count, product) → update counted_qty
 *   and the counted_at / source / counted_by fields.
 * - If no baseline line exists (out of scope):
 *     - `force = false` → throw OUT_OF_SCOPE so the client can prompt the
 *       owner "not in scope — add anyway?".
 *     - `force = true` → insert a new row with baseline = current qty NOW,
 *       added_mid_count = true, and the provided counted_qty.
 *
 * Flipping the count status from 'draft' to 'in_progress' happens here the
 * first time a line is touched.
 */
export async function upsertLine(
  tenantId: string,
  countId: string,
  productId: string,
  input: {
    countedQty: number;
    source: CountLineSource;
    countedByUserId: string;
    force?: boolean;
  },
): Promise<InventoryCountLineRow> {
  if (!Number.isInteger(input.countedQty) || input.countedQty < 0) {
    throw new Error("counted_qty must be a non-negative integer");
  }
  return withTenant(tenantId, async (tx) => {
    // Lock the count row to serialize line edits against a concurrent confirm.
    const [count] = await tx
      .select()
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)))
      .for("update");
    if (!count) throw new InventoryCountConflictError("COUNT_NOT_FOUND");
    if (count.status !== "draft" && count.status !== "in_progress" && count.status !== "review") {
      throw new InventoryCountConflictError("INVALID_STATUS", { status: count.status });
    }

    // Ensure the product exists before touching a line.
    const [product] = await tx
      .select({ id: products.id, quantity: products.quantity })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
      .limit(1);
    if (!product) throw new InventoryCountConflictError("COUNT_NOT_FOUND", { reason: "product_missing" });

    const now = new Date();

    const [existing] = await tx
      .select()
      .from(inventoryCountLines)
      .where(and(eq(inventoryCountLines.countId, countId), eq(inventoryCountLines.productId, productId)))
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(inventoryCountLines)
        .set({
          countedQty: input.countedQty,
          source: input.source,
          countedAt: now,
          countedByUserId: input.countedByUserId,
        })
        .where(eq(inventoryCountLines.id, existing.id))
        .returning();
      await bumpStatusIfDraft(tx, tenantId, countId);
      return updated!;
    }

    // Out of scope: baseline row never existed.
    if (!input.force) {
      throw new InventoryCountConflictError("OUT_OF_SCOPE", {
        productId,
        currentQty: product.quantity,
      });
    }

    const [inserted] = await tx
      .insert(inventoryCountLines)
      .values({
        countId,
        tenantId,
        productId,
        baselineQty: product.quantity,
        countedQty: input.countedQty,
        source: input.source,
        countedAt: now,
        countedByUserId: input.countedByUserId,
        addedMidCount: true,
      })
      .returning();
    await bumpStatusIfDraft(tx, tenantId, countId);
    return inserted!;
  });
}

async function bumpStatusIfDraft(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  countId: string,
): Promise<void> {
  await tx
    .update(inventoryCounts)
    .set({ status: "in_progress" })
    .where(
      and(
        eq(inventoryCounts.tenantId, tenantId),
        eq(inventoryCounts.id, countId),
        eq(inventoryCounts.status, "draft"),
      ),
    );
}

export async function deleteLine(
  tenantId: string,
  countId: string,
  productId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [count] = await tx
      .select({ status: inventoryCounts.status })
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)))
      .for("update");
    if (!count) throw new InventoryCountConflictError("COUNT_NOT_FOUND");
    if (count.status === "completed" || count.status === "cancelled") {
      throw new InventoryCountConflictError("INVALID_STATUS", { status: count.status });
    }
    await tx
      .delete(inventoryCountLines)
      .where(
        and(
          eq(inventoryCountLines.tenantId, tenantId),
          eq(inventoryCountLines.countId, countId),
          eq(inventoryCountLines.productId, productId),
        ),
      );
  });
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

export async function cancelCount(
  tenantId: string,
  countId: string,
  cancelledByUserId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [count] = await tx
      .select({ status: inventoryCounts.status })
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)))
      .for("update");
    if (!count) throw new InventoryCountConflictError("COUNT_NOT_FOUND");
    if (count.status === "completed") {
      throw new InventoryCountConflictError("ALREADY_CONFIRMED");
    }
    if (count.status === "cancelled") return; // idempotent
    await tx
      .update(inventoryCounts)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledByUserId })
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)));
  });
}

// ─── Confirm (THE reconciliation) ────────────────────────────────────────────

export interface ConfirmResult {
  countId: string;
  confirmedAt: string;
  reconciliations: InventoryCountReconciliationRow[];
  appliedAdjustments: number;
}

export async function confirmCount(
  tenantId: string,
  countId: string,
  input: {
    confirmedByUserId: string;
    idempotencyKey: string;
  },
): Promise<ConfirmResult> {
  return withTenant(tenantId, async (tx) => {
    // 0) Lock the count row. Serializes two devices racing a confirm.
    const [count] = await tx
      .select()
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)))
      .for("update");
    if (!count) throw new InventoryCountConflictError("COUNT_NOT_FOUND");

    // Idempotent replay: same key + already completed → return previous result.
    if (count.status === "completed") {
      if (count.confirmIdempotencyKey && count.confirmIdempotencyKey === input.idempotencyKey) {
        const recs = await tx
          .select()
          .from(inventoryCountReconciliations)
          .where(
            and(
              eq(inventoryCountReconciliations.tenantId, tenantId),
              eq(inventoryCountReconciliations.countId, countId),
            ),
          );
        return {
          countId,
          confirmedAt: count.confirmedAt!.toISOString(),
          reconciliations: recs,
          appliedAdjustments: recs.filter((r) => r.adjustment !== 0).length,
        };
      }
      throw new InventoryCountConflictError("ALREADY_CONFIRMED");
    }
    if (count.status === "cancelled") {
      throw new InventoryCountConflictError("INVALID_STATUS", { status: count.status });
    }

    // 1) Preflight — mark lines whose product was deleted. If any counted line
    //    references a missing product, we refuse the confirm so the owner
    //    resolves the exception explicitly (silent-skip is not acceptable).
    //    Products are hard-deleted (no deleted_at column) — "missing" = no row.
    await tx.execute(sql`
      UPDATE inventory_count_lines l
      SET product_missing_at_confirm = (
        NOT EXISTS (
          SELECT 1 FROM products p
          WHERE p.id = l.product_id AND p.tenant_id = ${tenantId}
        )
      )
      WHERE l.count_id = ${countId}
    `);
    const invalid = await tx
      .select({ productId: inventoryCountLines.productId })
      .from(inventoryCountLines)
      .where(
        and(
          eq(inventoryCountLines.countId, countId),
          eq(inventoryCountLines.productMissingAtConfirm, true),
          isNotNull(inventoryCountLines.countedQty),
        ),
      );
    if (invalid.length > 0) {
      throw new InventoryCountConflictError("COUNT_HAS_INVALID_LINES", {
        invalidProductIds: invalid.map((x) => x.productId),
      });
    }

    // 2) Gather counted lines (valid products only; preflight flagged the rest).
    const lines = await tx
      .select()
      .from(inventoryCountLines)
      .where(
        and(
          eq(inventoryCountLines.tenantId, tenantId),
          eq(inventoryCountLines.countId, countId),
          isNotNull(inventoryCountLines.countedQty),
          eq(inventoryCountLines.productMissingAtConfirm, false),
        ),
      );

    const reconciliations: InventoryCountReconciliationRow[] = [];
    let appliedAdjustments = 0;

    // 3) Per line reconciliation. Row-lock each product via _applyAdjustment;
    //    compute movement_after_count from product_history; apply adjustment.
    for (const line of lines) {
      const countedQty = line.countedQty!;
      const countedAt = line.countedAt!;

      // Σ movements committed AFTER the physical count was recorded. Pass
      // counted_at as an ISO string: the postgres driver's placeholder
      // binding rejects a Date object directly.
      const countedAtIso =
        countedAt instanceof Date ? countedAt.toISOString() : String(countedAt);
      const moveRows = (await tx.execute(sql`
        SELECT COALESCE(SUM(delta), 0)::int AS sum_delta
        FROM product_history
        WHERE tenant_id = ${tenantId}
          AND product_id = ${line.productId}
          AND created_at > ${countedAtIso}
      `)) as unknown as Array<{ sum_delta: number }>;
      const movementAfterCount = Number(moveRows[0]?.sum_delta ?? 0);

      const expectedPhysical = countedQty + movementAfterCount;

      // _applyAdjustment row-locks the product, reads current qty under the
      // lock, writes the UPDATE + product_history, returns new qty + history id.
      // We invoke it with the computed adjustment so the final quantity exactly
      // equals expected_physical regardless of any sale/receive between our
      // SUM and our UPDATE (both happen inside the same lock window).
      const [currentRow] = await tx
        .select({ q: products.quantity })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.id, line.productId)))
        .for("update");
      const currentQty = currentRow?.q ?? 0;
      const adjustment = expectedPhysical - currentQty;

      let productHistoryId: string | null = null;
      if (adjustment !== 0) {
        const applied = await _applyAdjustment(tx, tenantId, line.productId, adjustment, {
          note: `inventory_count:${countId}`,
          createdByUserId: input.confirmedByUserId,
        });
        productHistoryId = applied.productHistoryId;
        appliedAdjustments += 1;
      }

      const [rec] = await tx
        .insert(inventoryCountReconciliations)
        .values({
          tenantId,
          countId,
          productId: line.productId,
          baselineQty: line.baselineQty,
          countedQty,
          countedAt,
          movementAfterCount,
          currentQtyAtConfirm: currentQty,
          expectedPhysical,
          adjustment,
          productHistoryId,
        })
        .returning();
      reconciliations.push(rec!);
    }

    // 4) Flip status and stamp confirm metadata — including the idempotency
    //    key. The partial unique index on (tenant_id, confirm_idempotency_key)
    //    makes a replay with the same key collide and roll back.
    const confirmedAt = new Date();
    await tx
      .update(inventoryCounts)
      .set({
        status: "completed",
        confirmedAt,
        confirmedByUserId: input.confirmedByUserId,
        confirmIdempotencyKey: input.idempotencyKey,
      })
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)));

    return {
      countId,
      confirmedAt: confirmedAt.toISOString(),
      reconciliations,
      appliedAdjustments,
    };
  });
}

// ─── Reconciliations fetch (history detail) ──────────────────────────────────

export async function listReconciliations(
  tenantId: string,
  countId: string,
): Promise<InventoryCountReconciliationRow[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(inventoryCountReconciliations)
      .where(
        and(
          eq(inventoryCountReconciliations.tenantId, tenantId),
          eq(inventoryCountReconciliations.countId, countId),
        ),
      )
      .orderBy(sql`${inventoryCountReconciliations.createdAt} ASC`),
  );
}

// ─── Report (post-confirm, authoritative) ────────────────────────────────────

export interface CountReportHeader {
  countId: string;
  /** Short display ref, e.g. "IC-A1B2C3". Derived from the UUID; stable. */
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
  /** Only present when every line in the count had a non-null cost_price.
   *  Signed EGP: negative = shrinkage (loss), positive = found stock gained. */
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
  /** Signed EGP for this one line; null when the product had no cost_price. */
  valueImpact: number | null;
  addedMidCount: boolean;
}

export interface CountReport {
  header: CountReportHeader;
  summary: CountReportSummary;
  lines: CountReportLine[];
}

const SCOPE_ALL = "all" as const;

function scopeKindToLabel(k: CountScopeKind): string {
  switch (k) {
    case "all":
      return "All products";
    case "category":
      return "Category";
    case "brand":
      return "Brand";
  }
}

/**
 * Build the authoritative report payload for a count. Uses the
 * `inventory_count_reconciliations` rows written by confirm — never
 * recomputed via `counted - baseline`, because that ignores
 * concurrent movement that the confirm did factor in.
 *
 * Draft / in_progress / review / cancelled counts have no reconciliation
 * rows, so they fall back to a simpler projection (baseline vs counted)
 * and never report a financial impact.
 */
export async function getCountReport(
  tenantId: string,
  countId: string,
): Promise<CountReport | null> {
  return withTenant(tenantId, async (tx) => {
    const [count] = await tx
      .select()
      .from(inventoryCounts)
      .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.id, countId)))
      .limit(1);
    if (!count) return null;

    type UserPick = { id: string; name: string | null; email: string };
    const userIds = [count.createdByUserId, count.confirmedByUserId].filter(
      (x): x is string => x != null,
    );
    let userMap = new Map<string, string>();
    if (userIds.length > 0) {
      const userRows = (await tx.execute(sql`
        SELECT id::text AS id, name, email FROM users WHERE id IN (${sql.join(
          userIds.map((u) => sql`${u}::uuid`),
          sql`, `,
        )})
      `)) as unknown as UserPick[];
      userMap = new Map(
        userRows.map((u) => [u.id, (u.name ?? "").trim() || u.email]),
      );
    }

    // Reconciliations are the source of truth for completed counts.
    type ReconRow = {
      product_id: string;
      baseline_qty: number;
      counted_qty: number;
      counted_at: string | Date;
      movement_after_count: number;
      current_qty_at_confirm: number;
      expected_physical: number;
      adjustment: number;
      name: string | null;
      sku: string | null;
      brand: string | null;
      category_id: string | null;
      cost_price: string | null;
      added_mid_count: boolean;
    };
    const reconRows = (await tx.execute(sql`
      SELECT
        r.product_id::text AS product_id,
        r.baseline_qty,
        r.counted_qty,
        r.counted_at,
        r.movement_after_count,
        r.current_qty_at_confirm,
        r.expected_physical,
        r.adjustment,
        p.name,
        p.sku,
        p.brand,
        p.category_id::text AS category_id,
        p.cost_price,
        COALESCE(l.added_mid_count, false) AS added_mid_count
      FROM inventory_count_reconciliations r
      LEFT JOIN products p ON p.id = r.product_id AND p.tenant_id = ${tenantId}
      LEFT JOIN inventory_count_lines l
        ON l.count_id = r.count_id AND l.product_id = r.product_id
      WHERE r.tenant_id = ${tenantId} AND r.count_id = ${countId}
      ORDER BY r.adjustment ASC, p.name ASC
    `)) as unknown as ReconRow[];

    // For unconfirmed counts, fall back to a direct projection from lines.
    let reportLines: CountReportLine[];
    let financialImpact: number | null;

    if (count.status === "completed" && reconRows.length > 0) {
      let allHaveCost = true;
      let impactSum = 0;
      reportLines = reconRows.map((r) => {
        const costNum = r.cost_price == null ? NaN : Number(r.cost_price);
        const hasCost = Number.isFinite(costNum) && costNum > 0;
        if (!hasCost) allHaveCost = false;
        const valueImpact = hasCost ? Number(r.adjustment) * costNum : null;
        if (valueImpact != null) impactSum += valueImpact;
        const countedAtIso =
          r.counted_at instanceof Date
            ? r.counted_at.toISOString()
            : new Date(String(r.counted_at)).toISOString();
        return {
          productId: r.product_id,
          productName: r.name ?? "(deleted product)",
          productSku: r.sku,
          brand: r.brand,
          categoryId: r.category_id,
          baselineQty: Number(r.baseline_qty),
          countedQty: Number(r.counted_qty),
          countedAt: countedAtIso,
          movementAfterCount: Number(r.movement_after_count),
          currentQtyAtConfirm: Number(r.current_qty_at_confirm),
          expectedPhysical: Number(r.expected_physical),
          adjustment: Number(r.adjustment),
          valueImpact,
          addedMidCount: Boolean(r.added_mid_count),
        };
      });
      financialImpact = allHaveCost && reportLines.length > 0 ? impactSum : null;
    } else {
      // Projection: baseline vs counted. No financial impact for drafts.
      type LineRow = {
        product_id: string;
        baseline_qty: number;
        counted_qty: number | null;
        counted_at: string | Date | null;
        name: string | null;
        sku: string | null;
        brand: string | null;
        category_id: string | null;
        added_mid_count: boolean;
      };
      const lineRows = (await tx.execute(sql`
        SELECT
          l.product_id::text AS product_id,
          l.baseline_qty,
          l.counted_qty,
          l.counted_at,
          p.name,
          p.sku,
          p.brand,
          p.category_id::text AS category_id,
          l.added_mid_count
        FROM inventory_count_lines l
        LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = ${tenantId}
        WHERE l.tenant_id = ${tenantId} AND l.count_id = ${countId}
          AND l.counted_qty IS NOT NULL
        ORDER BY (l.counted_qty - l.baseline_qty) ASC, p.name ASC
      `)) as unknown as LineRow[];
      reportLines = lineRows.map((r) => {
        const adj = Number(r.counted_qty ?? 0) - Number(r.baseline_qty);
        const countedAtIso = r.counted_at
          ? r.counted_at instanceof Date
            ? r.counted_at.toISOString()
            : new Date(String(r.counted_at)).toISOString()
          : "";
        return {
          productId: r.product_id,
          productName: r.name ?? "(deleted product)",
          productSku: r.sku,
          brand: r.brand,
          categoryId: r.category_id,
          baselineQty: Number(r.baseline_qty),
          countedQty: Number(r.counted_qty ?? 0),
          countedAt: countedAtIso,
          movementAfterCount: 0,
          currentQtyAtConfirm: Number(r.baseline_qty),
          expectedPhysical: Number(r.counted_qty ?? 0),
          adjustment: adj,
          valueImpact: null,
          addedMidCount: Boolean(r.added_mid_count),
        };
      });
      financialImpact = null;
    }

    const linesShortage = reportLines.filter((x) => x.adjustment < 0).length;
    const linesOverage = reportLines.filter((x) => x.adjustment > 0).length;
    const linesMatched = reportLines.length - linesShortage - linesOverage;
    const netAdjustment = reportLines.reduce((a, b) => a + b.adjustment, 0);
    const addedMidCount = reportLines.filter((x) => x.addedMidCount).length;

    const scope: CountScope = {
      kind: (count.scopeKind as CountScopeKind) ?? SCOPE_ALL,
      value: count.scopeValue ?? null,
    };

    // Resolve a human-readable label for category/brand scopes.
    let scopeLabel = scopeKindToLabel(scope.kind);
    if (scope.kind === "category" && scope.value) {
      const [cat] = await tx
        .select({ label: categories.label })
        .from(categories)
        .where(and(eq(categories.tenantId, tenantId), eq(categories.id, scope.value)))
        .limit(1);
      if (cat?.label) scopeLabel = `${scopeLabel}: ${cat.label}`;
    } else if (scope.kind === "brand" && scope.value) {
      scopeLabel = `${scopeLabel}: ${scope.value}`;
    }

    const header: CountReportHeader = {
      countId: count.id,
      ref: `IC-${count.id.slice(0, 8).toUpperCase()}`,
      status: count.status as CountStatus,
      scope,
      scopeLabel,
      createdAt: count.createdAt.toISOString(),
      createdByName: userMap.get(count.createdByUserId) ?? null,
      confirmedAt: count.confirmedAt ? count.confirmedAt.toISOString() : null,
      confirmedByName: count.confirmedByUserId
        ? userMap.get(count.confirmedByUserId) ?? null
        : null,
      scopeProductCount: count.scopeProductCount,
    };

    const summary: CountReportSummary = {
      linesTotal: reportLines.length,
      linesMatched,
      linesShortage,
      linesOverage,
      addedMidCount,
      netAdjustment,
      financialImpact,
    };

    return { header, summary, lines: reportLines };
  });
}
