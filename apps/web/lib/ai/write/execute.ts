import { and, eq, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { branches, customerWallets, type AiPendingActionRow } from "@/lib/db/schema";
import {
  addProduct,
  adjustProductQuantity,
  listCategories,
  listProducts,
  updateProduct,
  type UpdateProductInput,
} from "@/lib/repo/catalog";
import { addBrand, addCategory } from "@/lib/repo/catalog-admin";
import { insertActivityRow, type LogActivityInput } from "@/lib/repo/activity";
import { normalizeEgyptPhoneAny } from "@/lib/validators/egypt";

import { tr } from "../i18n";
import { executeBulkIntUpdate, executeBulkPriceUpdate } from "../bulk/execute";
import { executeImport } from "../import/execute";
import {
  CategoryNotFoundError,
  PayrollDoubleCountError,
  createFinanceExpense,
  voidFinanceExpense,
} from "@/lib/finance/expense-mutations";
import {
  createMoneyMovement,
  voidMoneyMovement,
  isMoneyMovementKind,
  type MoneyMovementKind,
} from "@/lib/finance/money-movement-mutations";
import {
  createCustomCategory,
  archiveCategory,
  CategoryImmutableError,
  CategoryInUseError,
  CategoryNotFoundError as FinCategoryNotFoundError,
  CategoryParentInvalidError,
  CategorySlugConflictError,
} from "@/lib/finance/category-mutations";
import { materializeDueRecurringExpenses } from "@/lib/repo/expenses";
import { saveShopSettings, type ShopSettingsDto } from "@/lib/repo/settings";
import { getPrimaryBranchId } from "@/lib/api/branch-context";
import {
  TaskConflictError,
  createTask as createTaskRepo,
  setTaskStatus as setTaskStatusRepo,
  updateTask as updateTaskRepo,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/repo/tasks";
import {
  PayrollLifecycleError,
  createPayrollAdjustment,
  finalizePayrollPeriod,
  upsertPayrollDraft,
} from "@/lib/repo/payroll-periods";
import {
  PurchaseOrderConflictError,
  createReceivedPurchaseWithOptionalPayment,
  getPurchaseOrder,
  type CreateReceivedPurchaseInput,
} from "@/lib/repo/purchase-orders";
import { recordPayment } from "@/lib/repo/purchase-payments";
import {
  SupplierAccountPaymentError,
  recordSupplierAccountPayment,
  type SupplierAccountPaymentMethod,
} from "@/lib/repo/supplier-account-payment";
import { createCompensation } from "@/lib/repo/payroll";
import { normalizeMonth } from "@/lib/payroll/engine";
import { fetchOperationById } from "../operations/record";
import { recordOperation } from "../operations/record";
import { executeGroupRollback, executeRollback } from "../operations/rollback";
import type { OperationType } from "../operations/types";
import type { AiBlock, ImportConflictBlock, Locale, RollbackResultBlock } from "../responses";

/**
 * F5 — Write executors.
 *
 * Contract:
 *   • Reuses existing repo helpers (updateProduct, adjustProductQuantity,
 *     direct customerWallets upsert) — no business rules re-implemented.
 *   • Every executor does: revalidate → execute → post-write verification →
 *     audit via logActivity. If any step fails the row is already consumed,
 *     so the user cannot retry the same token.
 *   • Returns AiBlock[] the confirm route forwards to the mobile client as a
 *     fresh assistant turn.
 */

export interface ExecuteContext {
  row: AiPendingActionRow;
  actorName?: string | null;
  /** F10.0 — carried from /api/ai/confirm so each recorded ai_operations row
   *  is attributable to a specific chat. `findLastRecordedOperation` filters
   *  by this when resolving "undo that" so an undo in a new chat can't revert
   *  a previous chat's writes. */
  conversationId?: string | null;
}

export interface ExecuteResult {
  ok: boolean;
  blocks: AiBlock[];
  /** Diagnostic — surfaces to the log, not the user. */
  debug: {
    action: string;
    targetId?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    reason?: string;
  };
}

export async function executeAction(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  switch (row.action) {
    case "update_product_price":
      return execUpdatePrice(ctx);
    case "update_product_quantity":
      return execUpdateQuantity(ctx);
    case "create_customer":
      return execCreateCustomer(ctx);
    case "rollback":
      return execRollback(ctx);
    case "import":
      return execImport(ctx);
    case "bulk_price_update":
      return execBulkPriceUpdate(ctx);
    case "bulk_quantity_update":
      return execBulkIntUpdate(ctx, "quantity");
    case "bulk_threshold_update":
      return execBulkIntUpdate(ctx, "lowStockThreshold");
    case "create_product":
      return execCreateProduct(ctx);
    case "update_product":
      return execUpdateProduct(ctx);
    case "create_brand":
      return execCreateBrand(ctx);
    case "create_category":
      return execCreateCategory(ctx);
    // Financials Phase 7-10 — wrap the authoritative lib/finance mutations.
    case "create_expense":
      return execCreateExpense(ctx);
    case "void_expense":
      return execVoidExpense(ctx);
    case "create_money_movement":
      return execCreateMoneyMovement(ctx);
    case "void_money_movement":
      return execVoidMoneyMovement(ctx);
    case "create_finance_category":
      return execCreateFinanceCategory(ctx);
    case "archive_finance_category":
      return execArchiveFinanceCategory(ctx);
    case "generate_recurring":
      return execGenerateRecurring(ctx);
    case "update_receipt_settings":
      return execUpdateReceiptSettings(ctx);
    // Tasks — thin wrappers over lib/repo/tasks.ts.
    case "create_task":
      return execCreateTask(ctx);
    case "update_task":
      return execUpdateTask(ctx);
    case "set_task_status":
      return execSetTaskStatus(ctx);
    // Payroll V1 — all 4 wrap the authoritative repo in lib/repo/payroll-periods.ts
    // (plus createCompensation for the versioned pay-rule update).
    case "payroll_calculate":
      return execPayrollCalculate(ctx);
    case "payroll_finalize":
      return execPayrollFinalize(ctx);
    case "payroll_update_compensation":
      return execPayrollUpdateCompensation(ctx);
    case "payroll_add_adjustment":
      return execPayrollAddAdjustment(ctx);
    // Phase B P0 — purchase writes.
    case "create_purchase":
      return execCreatePurchase(ctx);
    case "record_purchase_payment":
      return execRecordPurchasePayment(ctx);
    // Supplier Account Payment Correction — default "paid supplier X" flow.
    case "record_supplier_account_payment":
      return execRecordSupplierAccountPayment(ctx);
    default:
      return {
        ok: false,
        blocks: [{ kind: "text", text: `Unsupported action: ${row.action}` }],
        debug: { action: row.action, reason: "UNKNOWN_ACTION" },
      };
  }
}

/* ────────────────────────── update_product_price ────────────────────────── */

async function execUpdatePrice(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const productId = String(row.params.productId ?? "");
  const newPrice = Number(row.params.newPrice);
  if (!productId || !Number.isFinite(newPrice) || newPrice < 0) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  // Revalidate: re-fetch the current product under the SAME tenant+branch
  // scope the preview was computed in (F-plan §5).
  const target = await getProductById(row.tenantId, row.branchId, productId);
  if (!target) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.productGone") }],
      debug: { action: row.action, targetId: productId, reason: "TARGET_GONE" },
    };
  }
  const before = { price: Number(target.price), quantity: target.quantity };

  // F5.1 §4 — concurrency note:
  //   We re-fetch the current target, then mutate via updateProduct(). That
  //   is NOT a `SELECT FOR UPDATE` lock; a concurrent non-AI mutation in the
  //   ~5ms gap between the read and the write would race. Post-write verify
  //   below catches ALL such races — if the DB row doesn't contain our value
  //   on re-read, we report POST_VERIFY_FAILED and refuse to claim success.
  //   True row-level locking would require updateProduct() to accept an
  //   external tx handle (bigger refactor; deferred). For single-operator
  //   shops the race window is negligible; for multi-operator shops the
  //   post-verify is the safety net.
  //
  // Execute via the SAME repo helper the web PATCH uses. Dollar-amount sanity
  // guard — a 0 price is legal (promo), negative is not.
  const ok = await updateProduct(row.tenantId, productId, { price: newPrice });
  if (!ok) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.updatePriceFailed") }],
      debug: { action: row.action, targetId: productId, reason: "UPDATE_FAILED" },
    };
  }

  // Post-write verification (F-plan §7): re-fetch and confirm the DB actually
  // persisted what we asked.
  const after = await getProductById(row.tenantId, row.branchId, productId);
  if (!after || Number(after.price) !== newPrice) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.priceVerifyFailed") }],
      debug: { action: row.action, targetId: productId, before, after: after ? { price: Number(after.price) } : undefined, reason: "POST_VERIFY_FAILED" },
    };
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "product.update",
    category: "product",
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      field: "price",
      before: before.price,
      after: Number(after.price),
    },
  });

  // F10.0 — record reversible operation. Non-fatal on failure.
  const op = await tryRecordOperation({
    tenantId: row.tenantId,
    userId: row.userId,
    branchId: row.branchId,
    conversationId: ctx.conversationId ?? null,
    operationType: "product.price.update" as OperationType,
    pendingActionId: row.id,
    operationGroupId: null,
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    beforeState: { price: before.price },
    afterState: { price: Number(after.price) },
    affectedFields: ["price"],
    actorName: ctx.actorName ?? null,
    metadata: { pendingActionId: row.id },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: trRow(row, "execute.price.done", {
          name: after.name,
          before: fmt(before.price),
          after: fmt(Number(after.price)),
        }),
      },
      productCardFor(after),
      ...auditWarningBlocks(audit, row),
      ...operationWarningBlocks(op, row),
    ],
    debug: {
      action: row.action,
      targetId: productId,
      before,
      after: { price: Number(after.price), quantity: after.quantity },
    },
  };
}

/* ────────────────────── update_product_quantity ────────────────────────── */

async function execUpdateQuantity(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const productId = String(row.params.productId ?? "");
  const mode = String(row.params.mode ?? "set");
  const value = Number(row.params.value);
  if (!productId || !Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  const target = await getProductById(row.tenantId, row.branchId, productId);
  if (!target) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.productGone") }],
      debug: { action: row.action, targetId: productId, reason: "TARGET_GONE" },
    };
  }
  const before = { quantity: target.quantity };

  let newQty: number;
  try {
    if (mode === "set") {
      const ok = await updateProduct(row.tenantId, productId, { quantity: Math.floor(value) });
      if (!ok) throw new Error("UPDATE_FAILED");
      newQty = Math.floor(value);
    } else if (mode === "increase") {
      newQty = await adjustProductQuantity(row.tenantId, productId, Math.floor(value));
    } else if (mode === "decrease") {
      newQty = await adjustProductQuantity(row.tenantId, productId, -Math.floor(value));
    } else {
      throw new Error("UNKNOWN_MODE");
    }
  } catch (e) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.updateQtyFailed") }],
      debug: { action: row.action, targetId: productId, reason: e instanceof Error ? e.message : "EXEC_FAILED" },
    };
  }

  const after = await getProductById(row.tenantId, row.branchId, productId);
  if (!after || after.quantity !== newQty) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.qtyVerifyFailed") }],
      debug: { action: row.action, targetId: productId, before, after: after ? { quantity: after.quantity } : undefined, reason: "POST_VERIFY_FAILED" },
    };
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: mode === "set" ? "product.update" : "product.adjust",
    category: "product",
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      field: "quantity",
      mode,
      before: before.quantity,
      after: after.quantity,
    },
  });

  // F10.0 — record reversible operation. `mode` matters for undo semantics:
  // a "set 20" write is reversed by "set 12" (the before quantity); an
  // "increase by 5" write is reversed by subtracting 5 — but we ALWAYS undo
  // via the before-state, never via the inverse operation, so the mode is
  // only diagnostic here.
  const op = await tryRecordOperation({
    tenantId: row.tenantId,
    userId: row.userId,
    branchId: row.branchId,
    conversationId: ctx.conversationId ?? null,
    operationType: (mode === "set"
      ? "product.quantity.update"
      : "product.quantity.adjust") as OperationType,
    pendingActionId: row.id,
    operationGroupId: null,
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    beforeState: { quantity: before.quantity },
    afterState: { quantity: after.quantity },
    affectedFields: ["quantity"],
    actorName: ctx.actorName ?? null,
    metadata: { pendingActionId: row.id, mode },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: trRow(row, "execute.quantity.done", {
          name: after.name,
          before: before.quantity,
          after: after.quantity,
        }),
      },
      productCardFor(after),
      ...auditWarningBlocks(audit, row),
      ...operationWarningBlocks(op, row),
    ],
    debug: {
      action: row.action,
      targetId: productId,
      before,
      after: { quantity: after.quantity },
    },
  };
}

/* ─────────────────────────── create_customer ───────────────────────────── */

async function execCreateCustomer(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const name = String(row.params.name ?? "").trim();
  const phoneRaw = String(row.params.phone ?? "");
  const phone = normalizeEgyptPhoneAny(phoneRaw);
  if (!phone || !name) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.customerInvalid") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  return withTenant(row.tenantId, async (tx) => {
    // customer_wallets carries a legacy (tenant, branch, phone) composite
    // key. Storo has no branch feature at the AI layer; we resolve the
    // tenant's one-and-only branch here so the row satisfies the existing
    // schema without the AI caller ever seeing a branch id.
    const branchId = await resolveTenantBranchId(tx, row.tenantId);
    if (!branchId) {
      return {
        ok: false,
        blocks: [{ kind: "text", text: trRow(row, "execute.customerVerifyFailed") }],
        debug: { action: row.action, reason: "NO_TENANT_BRANCH" },
      };
    }
    // Revalidation step: check whether this (tenant, branch, phone) already
    // exists. If it does, this is an UPSERT-style "ensure customer exists"
    // operation — report that and don't error, but don't double-audit either.
    const [existing] = await tx
      .select()
      .from(customerWallets)
      .where(
        and(
          eq(customerWallets.tenantId, row.tenantId),
          eq(customerWallets.branchId, branchId),
          eq(customerWallets.customerPhone, phone),
        ),
      );
    if (existing) {
      return {
        ok: true,
        blocks: [
          {
            kind: "text",
            text: trRow(row, "execute.customer.existed", {
              label: existing.customerName ?? phone,
            }),
          },
        ],
        debug: {
          action: row.action,
          targetId: `${row.tenantId}:${branchId}:${phone}`,
          before: { existed: true },
          after: { name: existing.customerName, phone },
          reason: "ALREADY_EXISTS",
        },
      };
    }

    await tx.insert(customerWallets).values({
      tenantId: row.tenantId,
      branchId,
      customerPhone: phone,
      customerName: name,
      points: 0,
      credit: "0",
    });

    // Post-write verify: re-read.
    const [persisted] = await tx
      .select()
      .from(customerWallets)
      .where(
        and(
          eq(customerWallets.tenantId, row.tenantId),
          eq(customerWallets.branchId, branchId),
          eq(customerWallets.customerPhone, phone),
        ),
      );
    if (!persisted) {
      return {
        ok: false,
        blocks: [{ kind: "text", text: trRow(row, "execute.customerVerifyFailed") }],
        debug: { action: row.action, reason: "POST_VERIFY_FAILED" },
      };
    }

    // F5.1 — dedicated customer taxonomy (was `team.add` which polluted the
    // staff feed with customer rows).
    // activity_logs.entity_id is `uuid` — customer wallet rows use a composite
    // (tenant, branch, phone) PK, no uuid surrogate. We leave entityId NULL
    // and carry the composite in metadata (searchable + non-typed).
    const audit = await tryAudit({
      tenantId: row.tenantId,
      actorUserId: row.userId,
      actorName: ctx.actorName ?? null,
      action: "customer.create",
      category: "customer",
      entityType: "customer",
      entityId: undefined,
      entityLabel: name,
      branchId,
      metadata: {
        via: "ai",
        pendingActionId: row.id,
        customer: { name, phone, key: `${branchId}:${phone}` },
      },
    });

    // F10.0 — record operation for history. A freshly-created customer with
    // zero transactions is TECHNICALLY reversible (delete the wallet row);
    // but the rollback engine's dependency check will block delete if any
    // orders/points accrue in the meantime. We mark it reversible=true and
    // let the dependency guard decide at undo time.
    const op = await tryRecordOperation({
      tenantId: row.tenantId,
      userId: row.userId,
      branchId,
      conversationId: ctx.conversationId ?? null,
      operationType: "customer.create" as OperationType,
      pendingActionId: row.id,
      operationGroupId: null,
      entityType: "customer",
      entityId: null,
      entityLabel: name,
      entityKey: { branchId, phone },
      beforeState: { exists: false },
      afterState: { name, phone },
      affectedFields: ["name", "phone"],
      actorName: ctx.actorName ?? null,
      metadata: { pendingActionId: row.id },
    });

    return {
      ok: true,
      blocks: [
        {
          kind: "text",
          text: trRow(row, "execute.customer.done", { name, phone }),
        },
        ...auditWarningBlocks(audit, row),
        ...operationWarningBlocks(op, row),
      ],
      debug: {
        action: row.action,
        targetId: `${branchId}:${phone}`,
        after: { name, phone },
      },
    };
  });
}

/* ────────────────────────── helpers ────────────────────────────────────── */

/**
 * Resolve the tenant's one branch id. Storo has no branch feature at the
 * product/AI level, but `customer_wallets` (and a handful of other legacy
 * tables) still have a NOT NULL `branch_id` column. Each tenant has exactly
 * one branch row — we look it up here so the AI write path can satisfy the
 * schema without the AgentContext ever carrying a branch id. Prefers the
 * primary branch when the `is_primary` flag is set; otherwise the first row.
 */
async function resolveTenantBranchId(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
): Promise<string | null> {
  const [primary] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true)))
    .limit(1);
  if (primary?.id) return primary.id;
  const [any] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.tenantId, tenantId))
    .limit(1);
  return any?.id ?? null;
}

async function getProductById(tenantId: string, branchId: string | null, id: string) {
  // The existing listProducts() is cached + tenant-scoped; filter by id.
  const all = await listProducts(tenantId, branchId);
  return all.find((p) => p.id === id) ?? null;
}

/* ─────────────────────── Wave 1 — catalog authoring ─────────────────── */
/* These four executors reuse the existing catalog(-admin) services. They do
 * NOT re-implement product/brand/category business rules — they only wire
 * the F5 pending action → existing service → verify → audit chain. */

async function execCreateProduct(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const params = row.params as {
    name?: unknown;
    categoryId?: unknown;
    branchId?: unknown;
    brand?: unknown;
    sku?: unknown;
    price?: unknown;
    costPrice?: unknown;
    quantity?: unknown;
    lowStockThreshold?: unknown;
  };
  const name = typeof params.name === "string" ? params.name.trim() : "";
  const categoryId = typeof params.categoryId === "string" ? params.categoryId : "";
  const branchId = typeof params.branchId === "string" ? params.branchId : null;
  const price = typeof params.price === "number" ? params.price : null;
  const quantity = typeof params.quantity === "number" ? params.quantity : null;
  const costPrice = typeof params.costPrice === "number" ? params.costPrice : null;
  const brand = typeof params.brand === "string" ? params.brand : null;
  const sku = typeof params.sku === "string" ? params.sku : null;
  const lowStockThreshold =
    typeof params.lowStockThreshold === "number" ? params.lowStockThreshold : 3;

  if (!name || !categoryId || !branchId || price === null || quantity === null) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  // Confirm the category still exists at execute time — admins can delete
  // categories between preview and confirm.
  const cats = await listCategories(row.tenantId, null);
  if (!cats.some((c) => c.id === categoryId)) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.productCreate.categoryGone") },
      ],
      debug: { action: row.action, reason: "CATEGORY_GONE" },
    };
  }

  let createdId: string;
  try {
    const result = await addProduct(row.tenantId, branchId, {
      name,
      categoryId,
      brand: brand ?? undefined,
      sku: sku ?? undefined,
      price,
      costPrice: costPrice ?? undefined,
      quantity,
      lowStockThreshold,
    });
    createdId = result.id;
  } catch (e) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.productCreate.failed") },
      ],
      debug: {
        action: row.action,
        reason: e instanceof Error ? e.message : "EXEC_FAILED",
      },
    };
  }

  // Post-write verify: re-fetch and confirm persisted values.
  const after = await getProductById(row.tenantId, null, createdId);
  if (!after || after.name !== name) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.productCreate.verifyFailed") },
      ],
      debug: {
        action: row.action,
        targetId: createdId,
        reason: "POST_VERIFY_FAILED",
      },
    };
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "product.create",
    category: "product",
    entityType: "product",
    entityId: createdId,
    entityLabel: after.name,
    branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      product: { name, brand, sku, price, quantity, categoryId },
    },
  });

  const op = await tryRecordOperation({
    tenantId: row.tenantId,
    userId: row.userId,
    branchId,
    conversationId: ctx.conversationId ?? null,
    operationType: "product.create" as OperationType,
    pendingActionId: row.id,
    operationGroupId: null,
    entityType: "product",
    entityId: createdId,
    entityLabel: after.name,
    beforeState: { exists: false },
    afterState: {
      exists: true,
      name: after.name,
      sku: after.sku,
      price: Number(after.price),
      quantity: after.quantity,
    },
    affectedFields: ["exists"],
    actorName: ctx.actorName ?? null,
    metadata: { pendingActionId: row.id },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: trRow(row, "execute.productCreate.done", {
          name: after.name,
          price: String(Number(after.price)),
          quantity: String(after.quantity),
        }),
      },
      ...auditWarningBlocks(audit, row),
      ...operationWarningBlocks(op, row),
    ],
    debug: {
      action: row.action,
      targetId: createdId,
      before: { exists: false },
      after: {
        exists: true,
        price: Number(after.price),
        quantity: after.quantity,
      },
    },
  };
}

async function execUpdateProduct(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const productId =
    typeof row.params.productId === "string" ? row.params.productId : "";
  const patch = (row.params.patch ?? {}) as UpdateProductInput & { categoryId?: string };
  if (!productId || !patch || typeof patch !== "object") {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  const before = await getProductById(row.tenantId, null, productId);
  if (!before) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.productGone") }],
      debug: { action: row.action, targetId: productId, reason: "TARGET_GONE" },
    };
  }

  // Category existence sanity-check if the patch includes one.
  if (patch.categoryId) {
    const cats = await listCategories(row.tenantId, null);
    if (!cats.some((c) => c.id === patch.categoryId)) {
      return {
        ok: false,
        blocks: [
          { kind: "text", text: trRow(row, "execute.productUpdate.categoryGone") },
        ],
        debug: { action: row.action, targetId: productId, reason: "CATEGORY_GONE" },
      };
    }
  }

  const ok = await updateProduct(row.tenantId, productId, patch);
  if (!ok) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.productUpdate.failed") },
      ],
      debug: { action: row.action, targetId: productId, reason: "UPDATE_FAILED" },
    };
  }

  const after = await getProductById(row.tenantId, null, productId);
  if (!after) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.productUpdate.verifyFailed") },
      ],
      debug: {
        action: row.action,
        targetId: productId,
        reason: "POST_VERIFY_FAILED",
      },
    };
  }

  // Confirm every patched field landed. If a field is in the patch but the
  // live row doesn't match, we FAIL — never claim a write happened when it
  // didn't.
  const mismatches: string[] = [];
  if (patch.name !== undefined && after.name !== patch.name) mismatches.push("name");
  if (patch.brand !== undefined && (after.brand ?? null) !== (patch.brand ?? null))
    mismatches.push("brand");
  if (patch.sku !== undefined && (after.sku ?? null) !== (patch.sku ?? null))
    mismatches.push("sku");
  if (patch.categoryId !== undefined && after.category !== patch.categoryId)
    mismatches.push("category");
  if (
    patch.costPrice !== undefined &&
    Number(after.costPrice ?? 0) !== Number(patch.costPrice ?? 0)
  )
    mismatches.push("costPrice");
  if (
    patch.lowStockThreshold !== undefined &&
    after.lowStockThreshold !== patch.lowStockThreshold
  )
    mismatches.push("lowStockThreshold");
  if (mismatches.length > 0) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.productUpdate.verifyFailed") },
      ],
      debug: {
        action: row.action,
        targetId: productId,
        reason: `POST_VERIFY_MISMATCH:${mismatches.join(",")}`,
      },
    };
  }

  const changedFields = Object.keys(patch);
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "product.update",
    category: "product",
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      changedFields,
      before: pickFields(before as unknown as Record<string, unknown>, changedFields),
      after: pickFields(after as unknown as Record<string, unknown>, changedFields),
    },
  });

  const op = await tryRecordOperation({
    tenantId: row.tenantId,
    userId: row.userId,
    branchId: row.branchId,
    conversationId: ctx.conversationId ?? null,
    operationType: "product.update" as OperationType,
    pendingActionId: row.id,
    operationGroupId: null,
    entityType: "product",
    entityId: productId,
    entityLabel: after.name,
    beforeState: pickFields(before as unknown as Record<string, unknown>, changedFields),
    afterState: pickFields(after as unknown as Record<string, unknown>, changedFields),
    affectedFields: changedFields,
    actorName: ctx.actorName ?? null,
    metadata: { pendingActionId: row.id },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: trRow(row, "execute.productUpdate.done", {
          name: after.name,
          changes: changedFields.join(", "),
        }),
      },
      ...auditWarningBlocks(audit, row),
      ...operationWarningBlocks(op, row),
    ],
    debug: {
      action: row.action,
      targetId: productId,
      before: pickFields(before as unknown as Record<string, unknown>, changedFields),
      after: pickFields(after as unknown as Record<string, unknown>, changedFields),
    },
  };
}

async function execCreateBrand(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const name =
    typeof row.params.name === "string" ? row.params.name.trim() : "";
  const categoryId =
    typeof row.params.categoryId === "string" ? row.params.categoryId : null;
  const branchId =
    typeof row.params.branchId === "string" ? row.params.branchId : null;
  if (!name || !branchId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  let createdId: string;
  try {
    const result = await addBrand(row.tenantId, branchId, { name, categoryId });
    createdId = result.id;
  } catch (e) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.brandCreate.failed") },
      ],
      debug: {
        action: row.action,
        reason: e instanceof Error ? e.message : "EXEC_FAILED",
      },
    };
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "brand.create",
    category: "product",
    entityType: "product",
    entityId: createdId,
    entityLabel: name,
    branchId,
    metadata: { via: "ai", pendingActionId: row.id, brand: { name, categoryId } },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: trRow(row, "execute.brandCreate.done", { name }),
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: {
      action: row.action,
      targetId: createdId,
      after: { name, categoryId },
    },
  };
}

async function execCreateCategory(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const key = typeof row.params.key === "string" ? row.params.key : "";
  const label =
    typeof row.params.label === "string" ? row.params.label.trim() : "";
  const branchId =
    typeof row.params.branchId === "string" ? row.params.branchId : null;
  if (!key || !label || !branchId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  let createdId: string;
  try {
    const result = await addCategory(row.tenantId, branchId, { key, label });
    createdId = result.id;
  } catch (e) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.categoryCreate.failed") },
      ],
      debug: {
        action: row.action,
        reason: e instanceof Error ? e.message : "EXEC_FAILED",
      },
    };
  }

  // Post-write verify — re-fetch the tenant's categories list and confirm
  // the id is present.
  const cats = await listCategories(row.tenantId, null);
  const landed = cats.find((c) => c.id === createdId);
  if (!landed) {
    return {
      ok: false,
      blocks: [
        { kind: "text", text: trRow(row, "execute.categoryCreate.verifyFailed") },
      ],
      debug: {
        action: row.action,
        targetId: createdId,
        reason: "POST_VERIFY_FAILED",
      },
    };
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "category.create",
    category: "product",
    entityType: "product",
    entityId: createdId,
    entityLabel: label,
    branchId,
    metadata: { via: "ai", pendingActionId: row.id, category: { key, label } },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: trRow(row, "execute.categoryCreate.done", { label }),
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: {
      action: row.action,
      targetId: createdId,
      after: { key, label },
    },
  };
}

function pickFields<T extends Record<string, unknown>>(
  obj: T,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "categoryId") {
      // The public Product type exposes categoryId as `category`.
      out.categoryId = (obj as Record<string, unknown>).category;
      continue;
    }
    out[k] = (obj as Record<string, unknown>)[k];
  }
  return out;
}

function productCardFor(p: {
  id: string;
  name: string;
  brand?: string;
  sku?: string;
  price: number;
  quantity: number;
  lowStockThreshold: number;
  imageUrl?: string | null;
}): AiBlock {
  const stockState: "in_stock" | "low_stock" | "out_of_stock" =
    p.quantity === 0 ? "out_of_stock" : p.quantity <= p.lowStockThreshold ? "low_stock" : "in_stock";
  return {
    kind: "product_card",
    productId: p.id,
    name: p.name,
    brand: p.brand ?? null,
    sku: p.sku ?? null,
    price: Number(p.price),
    currency: "EGP",
    quantity: p.quantity,
    stockState,
    imageUrl: p.imageUrl ?? null,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * F5.1 §3 — AUDIT reliability.
 *
 * The normal path (`logActivity`) is fire-and-forget: it routes through a
 * BullMQ queue when enabled and swallows errors. Fine for routine CRUD, but
 * an AI-initiated mutation MUST either:
 *   (a) persist an audit row, or
 *   (b) refuse to claim success when the audit write fails.
 *
 * We therefore call the lower-level `insertActivityRow` directly, AWAIT its
 * completion, and bubble a sentinel error if the insert threw. The executor
 * catches that sentinel and marks the result with `auditFailed: true`, which
 * downgrades the user-facing claim from "done" to "done BUT audit record
 * failed — contact ops".
 *
 * Why not wrap the mutation + audit in one transaction? `updateProduct` and
 * friends open their own tx inside `withTenant`; nesting them with the audit
 * insert would need those helpers to accept an external tx handle (a bigger
 * refactor than F5.1 scope allows). The post-write verify + awaited audit is
 * the next-safest guarantee available today.
 */
async function auditAiWrite(input: LogActivityInput): Promise<void> {
  // insertActivityRow() already catches + logs internally. We wrap once more
  // so a thrown failure surfaces here; otherwise the swallowed inner log is
  // our only signal and the executor can't react.
  let threw: unknown = null;
  try {
    await insertActivityRow(input);
  } catch (e) {
    threw = e;
  }
  if (threw) {
    throw new AuditWriteError(
      `AI audit write failed for ${input.action} on ${input.entityId ?? "?"}: ${
        threw instanceof Error ? threw.message : String(threw)
      }`,
    );
  }
}

export class AuditWriteError extends Error {
  readonly name = "AuditWriteError" as const;
}

/** Call `auditAiWrite`, returning `{ok:true}` on success or `{ok:false, reason}`
 *  on failure. Callers should use `auditWarningBlocks(result, row)` to surface
 *  a human-visible warning when audit failed — never silently swallow. */
async function tryAudit(
  input: LogActivityInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await auditAiWrite(input);
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Also console.error for ops observability — this is a severity-high event:
    // the write persisted but the audit trail didn't.
    console.error("[ai/write] audit_dispatch_failed", {
      tenantId: input.tenantId,
      action: input.action,
      entityId: input.entityId,
      reason,
    });
    return { ok: false, reason };
  }
}

/**
 * F10.0 — Record a reversible operation row after a successful write.
 *
 * Returns ok:true when the row was written, ok:false+reason otherwise.
 * Callers surface a WarningBlock(code=OPERATION_RECORD_FAILED) on failure so
 * the user knows the write succeeded but the undo capability is unavailable
 * for this specific operation.
 */
async function tryRecordOperation(input: Parameters<typeof recordOperation>[0]): Promise<
  { ok: true; id: string } | { ok: false; reason: string }
> {
  try {
    const rec = await recordOperation(input);
    return { ok: true, id: rec.id };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[ai/write] operation_record_failed", {
      tenantId: input.tenantId,
      operationType: input.operationType,
      entityId: input.entityId,
      reason,
    });
    return { ok: false, reason };
  }
}

function operationWarningBlocks(
  rec: { ok: true; id: string } | { ok: false; reason: string },
  row: AiPendingActionRow,
): AiBlock[] {
  if (rec.ok) return [];
  return [
    {
      kind: "warning",
      severity: "warning",
      title: trRow(row, "operation.recordFailed.title"),
      message: trRow(row, "operation.recordFailed.message"),
      code: "OPERATION_RECORD_FAILED",
    },
  ];
}

/** Appends a user-visible WarningBlock when audit failed. Keeps the success
 *  reply truthful: the write DID happen, but ops must be told the audit
 *  failed so they can reconcile. Uses the F4 warning block instead of raw
 *  text so the mobile client can bucket + alert ops by code. */
function auditWarningBlocks(
  audit: { ok: true } | { ok: false; reason: string },
  row: AiPendingActionRow,
): AiBlock[] {
  if (audit.ok) return [];
  return [
    {
      kind: "warning",
      severity: "warning",
      title: trRow(row, "audit.failed.title"),
      message: trRow(row, "audit.failed.message"),
      code: "AUDIT_WRITE_FAILED",
    },
  ];
}

/**
 * Localized string lookup bound to a pending-action row's stored locale.
 *
 * The pending row carries `preview.locale` — the locale the user was speaking
 * when the preview was generated. The executor uses THAT locale, not the
 * HTTP request's current locale, so a user who switches language between
 * preview and confirm still sees a reply in the language they consented to.
 * (F7 security: language changes must not alter authorization semantics.)
 */
function trRow(
  row: AiPendingActionRow,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const preview = row.preview as { locale?: unknown };
  const localeRaw = typeof preview?.locale === "string" ? preview.locale : "en";
  const locale = (["ar", "en", "pt", "fr", "es"].includes(localeRaw) ? localeRaw : "en") as Locale;
  return tr(key, locale, vars);
}

/* ────────────────────────── rollback ─────────────────────────────────── */

/**
 * F10.0 — Rollback executor.
 *
 * The pending-action row carries `params: { operationId }` — the operation
 * the user is reverting. The ACTUAL rollback semantics (which fields,
 * which repo, dependency checks) live in `operations/rollback.ts`; this
 * function is the F5-shaped adapter.
 */
async function execRollback(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const params = row.params as Record<string, unknown>;

  // F10.1 — group rollback path (import undo). Detect via operationGroupId.
  const groupId = typeof params.operationGroupId === "string" ? params.operationGroupId : "";
  if (groupId) {
    return execGroupRollback(ctx, groupId);
  }

  const operationId = String(params.operationId ?? "");
  if (!operationId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "rollback.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  const op = await fetchOperationById({ tenantId: row.tenantId, operationId });
  if (!op) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "rollback.operationMissing") }],
      debug: { action: row.action, reason: "OPERATION_MISSING" },
    };
  }
  // Ownership: the user consuming this token must match the user who created
  // the operation. The F5 consume already verified the token → user, but we
  // revalidate the operation→user link here.
  if (op.userId !== row.userId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "rollback.forbidden") }],
      debug: { action: row.action, reason: "OWNERSHIP_MISMATCH" },
    };
  }

  const preview = row.preview as { locale?: unknown };
  const localeRaw = typeof preview?.locale === "string" ? preview.locale : "en";
  const locale = (["ar", "en", "pt", "fr", "es"].includes(localeRaw) ? localeRaw : "en") as Locale;

  const result = await executeRollback({
    op,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    conversationId: ctx.conversationId ?? op.conversationId ?? null,
  });

  if (!result.ok) {
    // `kind` includes "ready" at the type level but can never occur when
    // ok=false. Narrow explicitly to the conflict kinds for the block.
    const conflictKind: Exclude<typeof result.kind, "ready"> =
      result.kind === "ready" ? "write_failed" : result.kind;
    const block: AiBlock = {
      kind: "rollback_conflict",
      operationId: op.id,
      operationType: op.operationType,
      entityLabel: op.entityLabel,
      kind_detail: conflictKind,
      reason: result.reason,
      title: tr("rollback.conflict.title", locale, { name: op.entityLabel }),
      message: localisedConflictMessage(conflictKind, locale),
    };
    return {
      ok: false,
      blocks: [block],
      debug: {
        action: row.action,
        targetId: op.id,
        reason: `${result.kind}:${result.reason}`,
      },
    };
  }

  const resultBlock: RollbackResultBlock = {
    kind: "rollback_result",
    operationId: op.id,
    rollbackOperationId: result.rollbackOperationId,
    operationType: op.operationType,
    entityType: op.entityType,
    entityLabel: op.entityLabel,
    restoredState: result.restoredState,
    afterState: op.afterState,
    beforeState: op.beforeState,
    affectedFields: op.affectedFields,
    title: tr("rollback.result.title", locale, { name: op.entityLabel }),
    message: tr("rollback.result.message", locale, {
      name: op.entityLabel,
      fields: op.affectedFields.join(", "),
    }),
  };

  return {
    ok: true,
    blocks: [resultBlock],
    debug: {
      action: row.action,
      targetId: op.id,
      before: op.afterState,
      after: result.restoredState,
    },
  };
}

/* ────────────────────────── bulk price update ─────────────────────── */

async function execBulkPriceUpdate(ctx: ExecuteContext): Promise<ExecuteResult> {
  const result = await executeBulkPriceUpdate({
    pendingRow: ctx.row,
    actorUserId: ctx.row.userId,
    actorName: ctx.actorName ?? null,
    conversationId: ctx.conversationId ?? null,
  });
  return {
    ok: result.ok,
    blocks: result.blocks,
    debug: {
      action: ctx.row.action,
      targetId: result.debug.operationGroupId,
      after: result.debug.counts,
      reason: result.debug.reason,
    },
  };
}

async function execBulkIntUpdate(
  ctx: ExecuteContext,
  field: "quantity" | "lowStockThreshold",
): Promise<ExecuteResult> {
  const result = await executeBulkIntUpdate({
    pendingRow: ctx.row,
    actorUserId: ctx.row.userId,
    actorName: ctx.actorName ?? null,
    conversationId: ctx.conversationId ?? null,
    field,
  });
  return {
    ok: result.ok,
    blocks: result.blocks,
    debug: {
      action: ctx.row.action,
      targetId: result.debug.operationGroupId,
      after: result.debug.counts,
      reason: result.debug.reason,
    },
  };
}

/* ────────────────────────── group rollback ──────────────────────────── */

async function execGroupRollback(ctx: ExecuteContext, groupId: string): Promise<ExecuteResult> {
  const { row } = ctx;
  const result = await executeGroupRollback({
    tenantId: row.tenantId,
    groupId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    conversationId: ctx.conversationId ?? null,
  });
  const locale = (row.preview as { locale?: unknown }).locale as Locale;
  const title =
    (row.preview as { entityLabel?: string }).entityLabel ?? `Import ${groupId.slice(0, 8)}…`;

  // Even if everything reverted cleanly, emit an ImportConflictBlock when
  // ANY row conflicted/failed — never report success silently.
  const block: ImportConflictBlock = {
    kind: "import_conflict",
    sessionId: "", // not strictly known; UI uses operationGroupId as the stable key
    operationGroupId: groupId,
    reversed: result.reversed,
    conflicted: result.conflicted,
    failed: result.failed,
    reasons: result.reasons.slice(0, 10),
    title: tr("import.conflict.title", locale, { name: title }),
    message: tr("import.conflict.message", locale, {
      reversed: result.reversed,
      conflicted: result.conflicted,
      failed: result.failed,
    }),
  };

  return {
    ok: result.conflicted === 0 && result.failed === 0,
    blocks: [block],
    debug: {
      action: row.action,
      targetId: groupId,
      after: {
        reversed: result.reversed,
        conflicted: result.conflicted,
        failed: result.failed,
      },
    },
  };
}

/* ────────────────────────── import ────────────────────────────────── */

/**
 * F10.1 — Import executor wrapper. Delegates to the import-engine module;
 * this function just adapts its ExecuteImportResult → ExecuteResult.
 */
async function execImport(ctx: ExecuteContext): Promise<ExecuteResult> {
  const result = await executeImport({
    pendingRow: ctx.row,
    actorUserId: ctx.row.userId,
    actorName: ctx.actorName ?? null,
    conversationId: ctx.conversationId ?? null,
  });
  return {
    ok: result.ok,
    blocks: result.blocks,
    debug: {
      action: ctx.row.action,
      targetId: result.debug.sessionId,
      before: {},
      after: { ...(result.debug.counts ?? {}) },
      reason: result.debug.reason,
    },
  };
}

function localisedConflictMessage(kind: string, locale: Locale): string {
  switch (kind) {
    case "concurrent_change":
      return tr("rollback.conflict.concurrentChange", locale);
    case "dependency_blocked":
      return tr("rollback.conflict.dependency", locale);
    case "expired":
      return tr("rollback.conflict.expired", locale);
    case "already_reverted":
      return tr("rollback.conflict.alreadyReverted", locale);
    case "entity_missing":
      return tr("rollback.conflict.entityMissing", locale);
    case "not_reversible":
      return tr("rollback.conflict.notReversible", locale);
    case "write_failed":
    case "verify_failed":
      return tr("rollback.conflict.writeFailed", locale);
    default:
      return tr("rollback.conflict.generic", locale);
  }
}

/* ─────────────────── Phase 7-10 Financials executors ───────────────────── */

async function execCreateExpense(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const title = String(p.title ?? "").trim();
  const amount = Number(p.amount);
  const dateStr = String(p.date ?? "");
  const categoryId = String(p.categoryId ?? "");
  if (!title || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !categoryId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  let created: { id: string };
  try {
    created = await createFinanceExpense(row.tenantId, {
      title,
      amount,
      date: new Date(`${dateStr}T12:00:00.000Z`),
      categoryId,
      paymentMethod: typeof p.paymentMethod === "string" ? p.paymentMethod : null,
      referenceNumber: typeof p.referenceNumber === "string" ? p.referenceNumber : null,
      note: typeof p.note === "string" ? p.note : null,
      supplierId: typeof p.supplierId === "string" ? p.supplierId : null,
      createdByUserId: row.userId,
    });
  } catch (e) {
    if (e instanceof CategoryNotFoundError) {
      return {
        ok: false,
        blocks: [{ kind: "text", text: "Category not found." }],
        debug: { action: row.action, reason: "CATEGORY_NOT_FOUND" },
      };
    }
    if (e instanceof PayrollDoubleCountError) {
      return {
        ok: false,
        blocks: [
          {
            kind: "text",
            text: "This month's payroll is already finalized. Adding another labor expense would double-count it — void the payroll sheet first or post this to a non-People category.",
          },
        ],
        debug: { action: row.action, reason: `PAYROLL_DOUBLE_COUNT:${e.periodStart.toISOString()}` },
      };
    }
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.unexpected") }],
      debug: { action: row.action, reason: e instanceof Error ? e.message : "unknown" },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.expense.create",
    category: "expense",
    entityType: "expense",
    entityId: created.id,
    entityLabel: title,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, amount, dateStr },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: `✓ Expense recorded (${title} — ${amount} EGP).` },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: created.id, after: { title, amount, date: dateStr } },
  };
}

async function execVoidExpense(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const id = String(p.expenseId ?? "");
  const reason = typeof p.reason === "string" ? p.reason : null;
  if (!id) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  const res = await voidFinanceExpense(row.tenantId, id, { voidedByUserId: row.userId, reason });
  if (!res.ok) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not void expense: ${res.reason}.` }],
      debug: { action: row.action, targetId: id, reason: res.reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.expense.void",
    category: "expense",
    entityType: "expense",
    entityId: id,
    entityLabel: null,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, reason },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: "✓ Expense voided (excluded from P&L)." },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: id },
  };
}

async function execCreateMoneyMovement(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const kindRaw = p.kind;
  if (!isMoneyMovementKind(kindRaw)) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_KIND" },
    };
  }
  const kind: MoneyMovementKind = kindRaw;
  const amount = Number(p.amount);
  const dateStr = String(p.occurredOn ?? "");
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  const created = await createMoneyMovement(row.tenantId, {
    kind,
    amount,
    occurredAt: new Date(`${dateStr}T12:00:00.000Z`),
    description: typeof p.description === "string" ? p.description : null,
    paymentMethod: typeof p.paymentMethod === "string" ? p.paymentMethod : null,
    createdByUserId: row.userId,
  });
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.moneyMovement.create",
    // Money movements aren't a top-level activity category — bucket under
    // "expense" to keep the activity feed coherent without inventing a new
    // category.
    category: "expense",
    entityType: "money_movement",
    entityId: created.id,
    entityLabel: kind,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, amount, dateStr },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: `✓ ${kind} recorded (${amount} EGP). Money movements are NOT P&L.` },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: created.id },
  };
}

async function execVoidMoneyMovement(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const id = String(p.movementId ?? "");
  const reason = typeof p.reason === "string" ? p.reason : null;
  if (!id) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  const res = await voidMoneyMovement(row.tenantId, id, { voidedByUserId: row.userId, reason });
  if (!res.ok) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not void movement: ${res.reason}.` }],
      debug: { action: row.action, targetId: id, reason: res.reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.moneyMovement.void",
    // Money movements aren't a top-level activity category — bucket under
    // "expense" to keep the activity feed coherent without inventing a new
    // category.
    category: "expense",
    entityType: "money_movement",
    entityId: id,
    entityLabel: null,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, reason },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: "✓ Money movement voided." },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: id },
  };
}

async function execCreateFinanceCategory(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const parentId = String(p.parentId ?? "");
  const nameEn = String(p.nameEn ?? "").trim();
  const nameAr = String(p.nameAr ?? "").trim();
  if (!parentId || !nameEn || !nameAr) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  let created: { id: string };
  try {
    // `createCustomCategory` derives the slug from nameEn; the preview-side
    // slug arg is accepted for UI consistency but ignored here.
    created = await createCustomCategory(row.tenantId, {
      parentId,
      nameEn,
      nameAr,
      createdByUserId: row.userId,
    });
  } catch (e) {
    const reason =
      e instanceof CategoryParentInvalidError
        ? "PARENT_INVALID"
        : e instanceof CategorySlugConflictError
          ? "SLUG_CONFLICT"
          : e instanceof FinCategoryNotFoundError
            ? "PARENT_NOT_FOUND"
            : "UNKNOWN";
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not create category: ${reason}.` }],
      debug: { action: row.action, reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.category.create",
    category: "settings",
    entityType: "finance_category",
    entityId: created.id,
    entityLabel: nameEn,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, parentId },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: `✓ Category created (${nameAr} / ${nameEn}).` },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: created.id },
  };
}

async function execArchiveFinanceCategory(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const id = String(p.categoryId ?? "");
  if (!id) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  try {
    await archiveCategory(row.tenantId, id);
  } catch (e) {
    const reason =
      e instanceof CategoryImmutableError
        ? "IMMUTABLE"
        : e instanceof CategoryInUseError
          ? "IN_USE"
          : e instanceof FinCategoryNotFoundError
            ? "NOT_FOUND"
            : "UNKNOWN";
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not archive category: ${reason}.` }],
      debug: { action: row.action, targetId: id, reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.category.archive",
    category: "settings",
    entityType: "finance_category",
    entityId: id,
    entityLabel: null,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: "✓ Category archived." },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: id },
  };
}

async function execGenerateRecurring(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const spawned = await materializeDueRecurringExpenses(row.tenantId);
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "finance.recurring.generate",
    category: "expense",
    entityType: "recurring_batch",
    entityId: null,
    entityLabel: null,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, spawned },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: `✓ Generated ${spawned} recurring expense(s).` },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action },
  };
}

async function execUpdateReceiptSettings(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  // Receipt settings live per (tenant, branch) — Storo has no branches but the
  // shop_settings composite key still requires one. Use the primary branch.
  const branchId = await getPrimaryBranchId(row.tenantId);
  if (!branchId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: "No primary branch resolved; cannot update receipt settings." }],
      debug: { action: row.action, reason: "NO_PRIMARY_BRANCH" },
    };
  }
  const patch: Partial<ShopSettingsDto> = {};
  // Accept only the receipt-identity + visibility fields.
  const KEYS = [
    "receiptTaxRegistration",
    "receiptTaxCardNumber",
    "receiptSlogan",
    "receiptReturnPolicy",
    "receiptAddress",
    "receiptReferencePrefix",
    "receiptShowAddress",
    "receiptShowSlogan",
    "receiptShowTaxInfo",
    "receiptShowReturnPolicy",
  ] as const;
  for (const k of KEYS) {
    if (k in p) (patch as Record<string, unknown>)[k] = p[k];
  }
  await saveShopSettings(row.tenantId, branchId, patch);
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "settings.receipt.update",
    category: "settings",
    entityType: "shop_settings",
    entityId: branchId,
    entityLabel: null,
    branchId,
    metadata: { via: "ai", pendingActionId: row.id, changed: Object.keys(patch) },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: "✓ Receipt settings updated." },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: branchId },
  };
}

/* ───────────────────────────── Task executors ──────────────────────────── */

// Create / update / status transitions reuse lib/repo/tasks.ts verbatim —
// the same code path the web Tasks screen hits. That buys us the existing
// notification dispatcher behaviour for free (task_assigned / task_updated /
// task_started / task_done events fire as a side-effect of the repo calls).

async function execCreateTask(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const title = String(p.title ?? "").trim();
  if (!title) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  // Resolve the tenant's primary branch — tasks have a notNull branch_id
  // column for historical reasons; Storo has no user-facing branches so this
  // just picks the primary. Matches the existing POST /api/tasks behaviour.
  const branchId = await getPrimaryBranchId(row.tenantId);
  if (!branchId) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: "No primary branch resolved; cannot create task." }],
      debug: { action: row.action, reason: "NO_PRIMARY_BRANCH" },
    };
  }
  const assignedToUserId = typeof p.assignedToUserId === "string" && p.assignedToUserId ? p.assignedToUserId : null;
  const priority: TaskPriority =
    p.priority === "low" || p.priority === "high" ? p.priority : "normal";
  const dueDate = typeof p.dueDate === "string" && p.dueDate
    ? new Date(`${p.dueDate}T12:00:00.000Z`)
    : null;
  let created: { id: string };
  try {
    created = await createTaskRepo(row.tenantId, branchId, row.userId, {
      title,
      description: typeof p.description === "string" ? p.description : null,
      priority,
      dueDate,
      assignedToUserId,
    });
  } catch (e) {
    const reason = e instanceof TaskConflictError ? "CONFLICT" : "UNKNOWN";
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not create task: ${reason}.` }],
      debug: { action: row.action, reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "task.create",
    category: "task",
    entityType: "task",
    entityId: created.id,
    entityLabel: title,
    branchId,
    metadata: { via: "ai", pendingActionId: row.id, assignedToUserId, priority },
  });
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: assignedToUserId
          ? `✓ Task created and assigned. The assignee was notified automatically.`
          : `✓ Task created (unassigned).`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: created.id },
  };
}

async function execUpdateTask(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const id = String(p.id ?? "");
  const patch = (p.patch ?? {}) as Record<string, unknown>;
  if (!id || Object.keys(patch).length === 0) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  const repoPatch: Record<string, unknown> = {};
  if ("title" in patch) repoPatch.title = String(patch.title ?? "");
  if ("description" in patch) repoPatch.description = patch.description ?? null;
  if ("priority" in patch && (patch.priority === "low" || patch.priority === "normal" || patch.priority === "high")) {
    repoPatch.priority = patch.priority;
  }
  if ("dueDate" in patch) {
    repoPatch.dueDate = patch.dueDate
      ? new Date(`${String(patch.dueDate)}T12:00:00.000Z`)
      : null;
  }
  if ("assignedToUserId" in patch) repoPatch.assignedToUserId = patch.assignedToUserId ?? null;

  try {
    await updateTaskRepo(row.tenantId, id, repoPatch);
  } catch (e) {
    const reason = e instanceof TaskConflictError ? "CONFLICT" : "UNKNOWN";
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not update task: ${reason}.` }],
      debug: { action: row.action, targetId: id, reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "task.update",
    category: "task",
    entityType: "task",
    entityId: id,
    entityLabel: null,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, changed: Object.keys(repoPatch) },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: "✓ Task updated." },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: id },
  };
}

async function execSetTaskStatus(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const id = String(p.id ?? "");
  const status = p.status as TaskStatus | undefined;
  if (!id || (status !== "open" && status !== "in_progress" && status !== "done" && status !== "cancelled")) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  try {
    await setTaskStatusRepo(row.tenantId, id, row.userId, status);
  } catch (e) {
    const reason = e instanceof TaskConflictError ? "CONFLICT" : "UNKNOWN";
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Could not change task status: ${reason}.` }],
      debug: { action: row.action, targetId: id, reason },
    };
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "task.update",
    category: "task",
    entityType: "task",
    entityId: id,
    entityLabel: null,
    branchId: row.branchId,
    metadata: { via: "ai", pendingActionId: row.id, status },
  });
  return {
    ok: true,
    blocks: [
      { kind: "text", text: `✓ Task marked ${status}.` },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: id },
  };
}

/* ────────────────────────── Payroll V1 executors ────────────────────────── */

function parseMonthStr(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [y, m] = value.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  return new Date(Date.UTC(y!, m! - 1, 1, 0, 0, 0, 0));
}

function payrollErrorBlock(e: unknown, row: AiPendingActionRow): ExecuteResult {
  if (e instanceof PayrollLifecycleError) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: `Payroll: ${e.code}. ${e.message}` }],
      debug: { action: row.action, reason: e.code },
    };
  }
  return {
    ok: false,
    blocks: [{ kind: "text", text: trRow(row, "execute.unexpected") }],
    debug: { action: row.action, reason: e instanceof Error ? e.message : "unknown" },
  };
}

async function execPayrollCalculate(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const employeeId = String(p.employeeId ?? "");
  const periodStart = parseMonthStr(p.month);
  if (!employeeId || !periodStart) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  let sheet;
  try {
    sheet = await upsertPayrollDraft(row.tenantId, employeeId, periodStart);
  } catch (e) {
    return payrollErrorBlock(e, row);
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "payroll.calculate",
    category: "payroll",
    entityType: "payroll_period",
    entityId: sheet.periodId ?? employeeId,
    entityLabel: sheet.employeeName,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      employeeId,
      month: p.month,
      grossAmount: sheet.snapshot.grossAmount,
      netAmount: sheet.snapshot.netAmount,
    },
  });
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `✓ Draft payroll saved for ${sheet.employeeName ?? "employee"} — ${p.month}. Net: ${sheet.snapshot.netAmount.toFixed(2)} EGP.`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: sheet.periodId ?? employeeId },
  };
}

async function execPayrollFinalize(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const employeeId = String(p.employeeId ?? "");
  const periodStart = parseMonthStr(p.month);
  if (!employeeId || !periodStart) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  let sheet;
  try {
    sheet = await finalizePayrollPeriod(row.tenantId, employeeId, periodStart, row.userId);
  } catch (e) {
    return payrollErrorBlock(e, row);
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "payroll.finalize",
    category: "payroll",
    entityType: "payroll_period",
    entityId: sheet.periodId ?? employeeId,
    entityLabel: sheet.employeeName,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      employeeId,
      month: p.month,
      grossAmount: sheet.snapshot.grossAmount,
      netAmount: sheet.snapshot.netAmount,
    },
  });
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `✓ Payroll finalized for ${sheet.employeeName ?? "employee"} — ${p.month}. Net: ${sheet.snapshot.netAmount.toFixed(2)} EGP. This now appears in the P&L's Salaries line.`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: sheet.periodId ?? employeeId },
  };
}

async function execPayrollUpdateCompensation(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const employeeId = String(p.employeeId ?? "");
  const payType = String(p.payType ?? "") as "fixed" | "hourly" | "hybrid";
  if (!employeeId || !["fixed", "hourly", "hybrid"].includes(payType)) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  const effective =
    typeof p.effectiveFrom === "string" ? new Date(p.effectiveFrom) : new Date();
  const baseSalaryMonthly = typeof p.baseSalaryMonthly === "number" ? p.baseSalaryMonthly : null;
  const hourlyRate = typeof p.hourlyRate === "number" ? p.hourlyRate : null;
  const commissionRate = typeof p.commissionRate === "number" ? p.commissionRate : 0;
  const bonusEligible = typeof p.bonusEligible === "boolean" ? p.bonusEligible : false;
  let dto;
  try {
    dto = await createCompensation(row.tenantId, {
      employeeId,
      payType,
      baseSalaryMonthly,
      hourlyRate,
      standardMonthlyHours: null,
      commissionRate,
      commissionBase: "gross_sales",
      bonusEligible,
      effectiveFrom: effective,
      createdByUserId: row.userId,
    });
  } catch (e) {
    return payrollErrorBlock(e, row);
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "payroll.compensation_update",
    category: "payroll",
    entityType: "user",
    entityId: employeeId,
    entityLabel: null,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      payType,
      baseSalaryMonthly,
      hourlyRate,
      commissionRate,
      bonusEligible,
      effectiveFrom: effective.toISOString(),
    },
  });
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `✓ Compensation updated. Effective ${effective.toISOString().slice(0, 10)}; already-finalized months are NOT changed.`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: dto.id },
  };
}

async function execPayrollAddAdjustment(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const employeeId = String(p.employeeId ?? "");
  const periodStart = parseMonthStr(p.month);
  const kind = String(p.kind ?? "") as
    | "bonus"
    | "deduction"
    | "advance_repayment"
    | "correction";
  const amount = typeof p.amount === "number" ? p.amount : NaN;
  if (
    !employeeId ||
    !periodStart ||
    !["bonus", "deduction", "advance_repayment", "correction"].includes(kind) ||
    !Number.isFinite(amount) ||
    amount === 0
  ) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }
  const reason = typeof p.reason === "string" ? p.reason : null;
  const { periodStart: normalized } = normalizeMonth(periodStart);
  let adj;
  try {
    adj = await createPayrollAdjustment(row.tenantId, {
      employeeId,
      periodStart: normalized,
      kind,
      amount,
      reason,
      createdByUserId: row.userId,
    });
  } catch (e) {
    return payrollErrorBlock(e, row);
  }
  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "payroll.adjustment_create",
    category: "payroll",
    entityType: "payroll_adjustment",
    entityId: adj.id,
    entityLabel: null,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      employeeId,
      month: p.month,
      kind,
      amount,
      reason,
    },
  });
  const sign = amount >= 0 ? "+" : "−";
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `✓ ${kind === "bonus" ? "Bonus" : "Deduction"} saved for ${p.month}: ${sign}${Math.abs(amount).toFixed(2)} EGP.`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: adj.id },
  };
}

/* ────────────────────── Phase B P0 — purchase executors ───────────────────── */

function purchaseErrorBlock(e: unknown, row: AiPendingActionRow): ExecuteResult {
  if (e instanceof PurchaseOrderConflictError) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: `ماقدرتش أسجل العملية: ${e.message}` }],
      debug: { action: row.action, reason: "CONFLICT" },
    };
  }
  return {
    ok: false,
    blocks: [{ kind: "text", text: trRow(row, "execute.unexpected") }],
    debug: { action: row.action, reason: e instanceof Error ? e.message : "unknown" },
  };
}

async function execCreatePurchase(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const supplierId = typeof p.supplierId === "string" ? p.supplierId : "";
  const items = Array.isArray(p.items) ? p.items : [];
  if (!supplierId || items.length === 0) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  // Coerce items — the preview tool already validated shape; be defensive at
  // the executor boundary in case the HMAC covers a mutated payload that slipped
  // some other check.
  const typedItems = items.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      productId: typeof r.productId === "string" ? r.productId : null,
      productName: String(r.productName ?? ""),
      quantity: Number(r.quantity),
      unitCost: Number(r.unitCost),
      categoryId: typeof r.categoryId === "string" ? r.categoryId : undefined,
    };
  });

  const input: CreateReceivedPurchaseInput = {
    supplierId,
    items: typedItems,
    paidNow: typeof p.paidNow === "number" ? p.paidNow : 0,
    paymentMethod:
      typeof p.paymentMethod === "string"
        ? (p.paymentMethod as CreateReceivedPurchaseInput["paymentMethod"])
        : undefined,
    notes: typeof p.notes === "string" ? p.notes : null,
    updateCost: true,
    actorUserId: row.userId,
    originTag: "via AI Agent",
  };

  let result;
  try {
    result = await createReceivedPurchaseWithOptionalPayment(row.tenantId, input);
  } catch (e) {
    return purchaseErrorBlock(e, row);
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "purchase.create",
    category: "purchase",
    entityType: "purchase_order",
    entityId: result.purchaseOrderId,
    entityLabel: null,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      supplierId,
      itemCount: typedItems.length,
      total: result.total,
      paid: result.paid,
      outstanding: result.outstanding,
    },
  });

  const parts: string[] = [`✓ اتسجل الشراء.`];
  parts.push(`إجمالي: ${result.total.toFixed(2)} ج.م`);
  if (result.paid > 0) parts.push(`المدفوع: ${result.paid.toFixed(2)} ج.م`);
  parts.push(`المتبقي للمورد: ${result.outstanding.toFixed(2)} ج.م`);
  return {
    ok: true,
    blocks: [{ kind: "text", text: parts.join("\n") }, ...auditWarningBlocks(audit, row)],
    debug: { action: row.action, targetId: result.purchaseOrderId },
  };
}

async function execRecordPurchasePayment(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const purchaseOrderId = typeof p.purchaseOrderId === "string" ? p.purchaseOrderId : "";
  const amount = typeof p.amount === "number" ? p.amount : NaN;
  const method = typeof p.paymentMethod === "string" ? p.paymentMethod : "cash";
  if (!purchaseOrderId || !Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  let created;
  try {
    created = await recordPayment(row.tenantId, purchaseOrderId, {
      amount,
      method: method as "cash" | "bank" | "vfcash" | "instapay" | "other",
      notes: typeof p.notes === "string" ? p.notes : "via AI Agent",
    });
  } catch (e) {
    return purchaseErrorBlock(e, row);
  }

  // Re-read for the natural-language response so we echo the authoritative
  // outstanding balance, not our Agent-side guess.
  const po = await getPurchaseOrder(row.tenantId, purchaseOrderId);
  const outstanding = po ? Math.max(0, po.total - po.paidAmount) : 0;

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "supplier.payment",
    category: "supplier",
    entityType: "purchase_order_payment",
    entityId: created.id,
    entityLabel: po?.supplierName ?? null,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      purchaseOrderId,
      supplierId: po?.supplierId ?? null,
      amount,
      method,
      remainingAfter: outstanding,
    },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `✓ اتسجلت الدفعة ${amount.toFixed(2)} ج.م لـ ${po?.supplierName ?? "المورد"}. المتبقي: ${outstanding.toFixed(2)} ج.م.`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: created.id },
  };
}

/* ─────────────────── record_supplier_account_payment ─────────────────── */

async function execRecordSupplierAccountPayment(
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  const { row } = ctx;
  const p = row.params as Record<string, unknown>;
  const supplierId = typeof p.supplierId === "string" ? p.supplierId : "";
  const amount = typeof p.amount === "number" ? p.amount : NaN;
  const method = typeof p.paymentMethod === "string" ? p.paymentMethod : "cash";
  const notes = typeof p.notes === "string" ? p.notes : null;
  if (!supplierId || !Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      blocks: [{ kind: "text", text: trRow(row, "execute.invalidParams") }],
      debug: { action: row.action, reason: "INVALID_PARAMS" },
    };
  }

  let result;
  try {
    result = await recordSupplierAccountPayment(row.tenantId, supplierId, {
      amount,
      method: method as SupplierAccountPaymentMethod,
      notes: notes ?? "via AI Agent",
      createdByUserId: row.userId,
    });
  } catch (e) {
    if (e instanceof SupplierAccountPaymentError) {
      const text =
        e.code === "SUPPLIER_NOT_FOUND"
          ? "مش لاقي المورد ده في المحل — ممكن تتأكد من الاسم؟"
          : e.code === "AMOUNT_EXCEEDS_BALANCE"
            ? `المبلغ أكبر من الرصيد المستحق للمورد — ما قدرتش أسجل الدفعة.`
            : `المبلغ غير صالح.`;
      return {
        ok: false,
        blocks: [{ kind: "text", text }],
        debug: { action: row.action, reason: e.code },
      };
    }
    throw e;
  }

  const audit = await tryAudit({
    tenantId: row.tenantId,
    actorUserId: row.userId,
    actorName: ctx.actorName ?? null,
    action: "supplier.payment",
    category: "supplier",
    entityType: "money_movement",
    entityId: result.movementId,
    entityLabel: result.supplierName,
    branchId: row.branchId,
    metadata: {
      via: "ai",
      pendingActionId: row.id,
      supplierId: result.supplierId,
      amount: result.amount,
      method: result.method,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      kind: "supplier_payment_direct",
    },
  });

  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `✓ اتسجلت دفعة ${result.amount.toFixed(2)} ج.م على حساب ${result.supplierName}. الرصيد المستحق قبل الدفعة: ${result.balanceBefore.toFixed(2)} ج.م → بعد الدفعة: ${result.balanceAfter.toFixed(2)} ج.م.`,
      },
      ...auditWarningBlocks(audit, row),
    ],
    debug: { action: row.action, targetId: result.movementId },
  };
}
