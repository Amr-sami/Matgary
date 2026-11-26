import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { captureWriteResult } from "@/lib/ai/context/capture";
import { loadContext, saveContext } from "@/lib/ai/context/store";
import { detectLocale } from "@/lib/ai/language";
import { getActiveProvider } from "@/lib/ai/providers";
import type { AgentResponse } from "@/lib/ai/responses";
import { fetchOperationById } from "@/lib/ai/operations/record";
import { bumpAuditFailure, bumpConfirmationReject, newRequestId } from "@/lib/ai/telemetry";
import { executeAction } from "@/lib/ai/write/execute";
import { consumePending } from "@/lib/ai/write/pending";

/**
 * F5 — Execute a previously-previewed AI write.
 *
 * Request body:
 *   { token: string }
 *
 * Lifecycle (F-plan §22, enforced here):
 *   1. requirePermission("view_insights") — only authenticated AI users.
 *   2. consumePending() atomically marks the server-side row consumed. Fails
 *      on: INVALID_TOKEN / NOT_FOUND / EXPIRED / ALREADY_CONSUMED /
 *      TENANT_MISMATCH / USER_MISMATCH / HMAC_MISMATCH.
 *   3. The permission required by the UNDERLYING action is re-checked HERE
 *      against the current session (owner bypass preserved) — can't preview
 *      as an owner then execute as a staffer.
 *   4. The executor re-fetches the target, runs the write via the existing
 *      repo helper, post-verifies, and writes an audit row.
 *   5. We return a fresh AgentResponse the mobile client appends as a new
 *      assistant turn.
 *
 * The client NEVER supplies the action parameters at this point — everything
 * executable lives in the server row the token points at.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(16).max(200),
  /** F6 — optional conversation id so the write can update the per-conv
   *  context with the verified post-write state. */
  conversationId: z.string().uuid().optional(),
});

// Mirror of AiActionType → the permission the executor's underlying write
// path enforces in the normal (non-AI) route. Revalidated here after the token
// consume so a cancelled permission mid-flight still blocks.
const ACTION_PERMISSION: Record<
  string,
  | "manage_inventory"
  | "record_sales"
  | "manage_expenses"
  | "manage_money_movements"
  | "manage_expense_categories"
  | "manage_recurring_expenses"
  | "view_settings"
  | "manage_tasks"
  | "manage_payroll"
  | "manage_purchases"
> = {
  update_product_price: "manage_inventory",
  update_product_quantity: "manage_inventory",
  create_customer: "record_sales",
  // F10.1 — bulk product import requires manage_inventory.
  import: "manage_inventory",
  // F10.3 — bulk ops require manage_inventory.
  bulk_price_update: "manage_inventory",
  bulk_quantity_update: "manage_inventory",
  bulk_threshold_update: "manage_inventory",
  // Wave 1 — catalog authoring. Same permission as the equivalent REST
  // routes (/api/products, /api/brands, /api/categories).
  create_product: "manage_inventory",
  update_product: "manage_inventory",
  create_brand: "manage_inventory",
  create_category: "manage_inventory",
  // Financials Phase 7-10 — mirror the HTTP routes.
  create_expense: "manage_expenses",
  void_expense: "manage_expenses",
  create_money_movement: "manage_money_movements",
  void_money_movement: "manage_money_movements",
  create_finance_category: "manage_expense_categories",
  archive_finance_category: "manage_expense_categories",
  generate_recurring: "manage_recurring_expenses",
  // Phase 12 — receipt settings staged update (owner-oriented; allow
  // view_settings holders in addition to the owner bypass).
  update_receipt_settings: "view_settings",
  // Tasks — mirror lib/repo/tasks.ts call sites (/api/tasks requires
  // manage_tasks for create / update / delete).
  create_task: "manage_tasks",
  update_task: "manage_tasks",
  set_task_status: "manage_tasks",
  // Payroll V1 — every write goes through the manage_payroll gate. Mirrors
  // apps/web/app/api/payroll/* which also enforce it.
  payroll_calculate: "manage_payroll",
  payroll_finalize: "manage_payroll",
  payroll_update_compensation: "manage_payroll",
  payroll_add_adjustment: "manage_payroll",
  // Phase B P0 — purchase writes gated by the existing `manage_purchases`
  // permission. Same permission the REST routes already enforce.
  create_purchase: "manage_purchases",
  record_purchase_payment: "manage_purchases",
  // Supplier Account Payment Correction — same permission as the PO-level
  // payment; both settle supplier payable, so no new permission class.
  record_supplier_account_payment: "manage_purchases",
};

// F10.0 — a rollback requires the same permission as the original operation.
// Resolved after consume by looking up the operation this rollback targets.
const OPERATION_PERMISSION: Record<string, "manage_inventory" | "record_sales"> = {
  "product.price.update": "manage_inventory",
  "product.quantity.update": "manage_inventory",
  "product.quantity.adjust": "manage_inventory",
  "product.create": "manage_inventory",
  "product.update": "manage_inventory",
  "customer.create": "record_sales",
};

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const r = await requirePermission("view_insights");
  if (!r.ok) {
    r.response.headers.set("X-Ai-Request-Id", requestId);
    return r.response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const consumed = await consumePending({
    tenantId: r.ctx.tenantId,
    userId: r.ctx.userId,
    token: parsed.data.token,
  });
  if (!consumed.ok) {
    bumpConfirmationReject();
    const status = consumed.reason === "ALREADY_CONSUMED" || consumed.reason === "EXPIRED" ? 409 : 403;
    const res = NextResponse.json(
      { error: "CONFIRMATION_REJECTED", reason: consumed.reason, requestId },
      { status },
    );
    res.headers.set("X-Ai-Request-Id", requestId);
    return res;
  }

  // Re-check the ACTION-specific permission on the current session. The
  // pending row stored under one permission would otherwise execute even if
  // the user's rights were revoked between preview and confirm.
  let needed = ACTION_PERMISSION[consumed.row.action];
  // F10.0 — rollback inherits the permission of the original operation.
  // F10.1 — a group rollback (operationGroupId in params) is always
  // manage_inventory (imports are gated there).
  if (consumed.row.action === "rollback") {
    const params = consumed.row.params as Record<string, unknown>;
    const groupId = typeof params.operationGroupId === "string" ? params.operationGroupId : "";
    if (groupId) {
      needed = "manage_inventory";
    } else {
      const opId = String(params.operationId ?? "");
      const op = opId
        ? await fetchOperationById({ tenantId: r.ctx.tenantId, operationId: opId })
        : null;
      if (op) needed = OPERATION_PERMISSION[op.operationType];
    }
  }
  if (needed && !r.ctx.permissions.includes(needed) && r.ctx.role !== "owner") {
    return NextResponse.json(
      { error: "FORBIDDEN", reason: `Missing permission: ${needed}` },
      { status: 403 },
    );
  }

  // Storo has no branch feature — tenant isolation is the primary security
  // boundary. Legacy `consumed.row.branchId` column may contain a null from
  // newer pending rows or a historical value from older ones; we do not use
  // it as a security gate. consumePending already enforces tenant+user match.

  // Locale for the success message: re-detect from the preview-time locale
  // (stored in the row) OR fall back to the current request locale. F7 —
  // supports ar/en/pt/fr/es.
  const previewLocale = (consumed.row.preview as { locale?: unknown })?.locale;
  const locale =
    previewLocale === "ar" || previewLocale === "en" || previewLocale === "pt" ||
    previewLocale === "fr" || previewLocale === "es"
      ? previewLocale
      : detectLocale([{ role: "user", content: "" }]);

  const start = Date.now();
  const result = await executeAction({
    row: consumed.row,
    conversationId: parsed.data.conversationId ?? null,
  });
  const elapsedMs = Date.now() - start;

  // F6 — update conversation context with the verified post-write state so
  // the next turn sees the new price/quantity and stale references die.
  if (result.ok && parsed.data.conversationId && result.debug.targetId) {
    try {
      const ctxRow = await loadContext({
        tenantId: r.ctx.tenantId,
        conversationId: parsed.data.conversationId,
      });
      if (ctxRow && ctxRow.tenantId === r.ctx.tenantId) {
        const action = consumed.row.action;
        const field =
          action === "update_product_price"
            ? "price"
            : action === "update_product_quantity"
              ? "quantity"
              : "customer";
        const beforeVal = (result.debug.before as { price?: number; quantity?: number } | undefined) ?? {};
        const afterVal = (result.debug.after as { price?: number; quantity?: number } | undefined) ?? {};
        const displayName =
          field === "price"
            ? ((consumed.row.preview as { productName?: unknown })?.productName as string) ?? result.debug.targetId
            : field === "quantity"
              ? ((consumed.row.preview as { productName?: unknown })?.productName as string) ?? result.debug.targetId
              : ((consumed.row.preview as { name?: unknown })?.name as string) ?? result.debug.targetId;
        captureWriteResult(ctxRow, {
          entityType: field === "customer" ? "customer" : "product",
          entityId: result.debug.targetId,
          displayName,
          branchId: consumed.row.branchId,
          field,
          before: field === "price" ? beforeVal.price : field === "quantity" ? beforeVal.quantity : undefined,
          after: field === "price" ? afterVal.price : field === "quantity" ? afterVal.quantity : undefined,
        });
        await saveContext(ctxRow);
      }
    } catch (e) {
      console.warn("[ai/confirm] context_update_failed", {
        reason: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  // Resolve the provider only for `model` / `provider` metadata echoed in the
  // response. We don't call the LLM here — the write is purely deterministic.
  let providerName = "n/a";
  let model = "n/a";
  try {
    const p = getActiveProvider();
    providerName = p.name;
    model = p.defaultModel;
  } catch {
    // Provider not configured — fine, writes don't need it.
  }

  // F8 — detect audit failure so the metrics counter picks it up. The warning
  // block carries code AUDIT_WRITE_FAILED (see F5.1 implementation).
  const auditFailed = result.blocks.some(
    (b) => b.kind === "warning" && b.code === "AUDIT_WRITE_FAILED",
  );
  if (auditFailed) bumpAuditFailure();

  console.info(
    "[ai/confirm] executed",
    JSON.stringify({
      requestId,
      tenantId: r.ctx.tenantId,
      userId: r.ctx.userId,
      pendingActionId: consumed.row.id,
      action: consumed.row.action,
      ok: result.ok,
      auditFailed,
      elapsedMs,
      debug: result.debug,
    }),
  );

  const response: AgentResponse = {
    blocks: result.blocks,
    locale,
    model,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolsCalled: [consumed.row.action],
    // F11 — confirmation execution is architecturally a NEW assistant turn
    // (user tapped Confirm → server ran a write → returned result blocks).
    // The id of that turn is derived from the HMAC id we just consumed, so
    // a double-tap or network retry would hit the "already consumed" branch
    // and never re-execute. Giving mobile this id means the result message
    // also carries stable identity.
    turnId: `confirm:${consumed.row.id}`,
  };
  // Even on executor failure (POST_VERIFY_FAILED, TARGET_GONE…) we return 200
  // + blocks; the row is already consumed and the user should see WHAT went
  // wrong instead of a generic 5xx.
  const res = NextResponse.json(response);
  res.headers.set("X-Ai-Request-Id", requestId);
  return res;
}
