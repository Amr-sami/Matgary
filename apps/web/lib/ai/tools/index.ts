import type { AgentContext } from "../context";
import { toToolContext } from "../context";
import type { AiBlock } from "../responses";

import { getTopBrands } from "./brands";
import { findCustomer, getCustomerDetails, getTopCustomers } from "./customers";
import {
  getAttendanceSummary,
  getEmployeesOnLeave,
  getSalesByEmployee,
} from "./employees";
import { getExpensesSummary } from "./expenses";
import {
  getCategoryProfitability,
  getFinancialTrends,
  getFinancialsOverview,
  getPnL,
  getProductProfitability,
} from "./financials";
import {
  listExpenses,
  listMoneyMovementsTool,
  listFinanceCategories,
} from "./finance-reads";
import { getPayrollSummary } from "./payroll";
import {
  getEmployeePayrollTool,
  listPayrollSheet,
  previewAddPayrollAdjustment,
  previewCalculatePayroll,
  previewFinalizePayroll,
  previewToggleBonusEligibility,
  previewUpdateCompensation,
} from "./payroll-v1";
import {
  listProductCategories,
  listSupplierProducts,
  previewCreatePurchase,
  previewRecordPurchasePayment,
  previewRecordSupplierAccountPayment,
} from "./purchases-write";
import {
  getReceiptSettings,
  prepareReceiptWhatsapp,
  previewUpdateReceiptSettings,
} from "./receipts";
import {
  previewArchiveFinanceCategory,
  previewCreateExpense,
  previewCreateFinanceCategory,
  previewCreateMoneyMovement,
  previewGenerateRecurring,
  previewVoidExpense,
  previewVoidMoneyMovement,
} from "./finance-writes";
import { applyImportCorrection, inspectImport, previewImport } from "./import";
import { getLowStock } from "./inventory";
import { searchKnowledgeTool } from "./knowledge";
import {
  getAverageBasketSize,
  getDeadStockProducts,
  getInactiveCustomers,
  getInventoryValue,
  getNewCustomers,
  getSalesByDayOfWeek,
  getSalesByHour,
  getSupplierPriceHistory,
  getZeroCostProducts,
} from "./analytics-wave2";
import { getPaymentMix } from "./payments";
import { getShopPulse, resolvePaymentCounterparty } from "./reasoning";
import { getProduct, getProductSalesHistory, searchProducts } from "./products";
import {
  getPurchaseOrderDetails,
  getPurchasesSummary,
  getRecentPurchaseOrders,
} from "./purchases";
import { getSalesComparison } from "./sales-compare";
import {
  getSupplierPaymentHistory,
  listUnpaidPurchaseOrders,
} from "./supplier-payments";
import { RENDER_TOOLS, isRenderTool } from "./render";
import {
  previewBulkPriceUpdate,
  previewBulkQuantityUpdate,
  previewBulkThresholdUpdate,
} from "./bulk";
import {
  findSupplier,
  getSupplierDetails,
  getTopSuppliers,
  resolveSupplier,
} from "./suppliers";
import { resolveEmployee } from "./employees-resolve";
import {
  getTaskTool,
  listTasksTool,
  previewCreateTask,
  previewSetTaskStatus,
  previewUpdateTask,
} from "./tasks";
import { listNotificationsTool, markNotificationsReadTool } from "./notifications";
import { findLastOperation, previewImportRollback, previewRollback } from "./undo";
import { getSalesOverview, getSalesTrend } from "./sales";
import {
  previewCreateCustomer,
  previewUpdateProductPrice,
  previewUpdateProductQuantity,
} from "./writes";
import {
  previewCreateBrand,
  previewCreateCategory,
  previewCreateProduct,
  previewUpdateProduct,
} from "./writes-catalog";
import type { Tool, ToolDefinition, ToolResult } from "./types";
import { toDefinition } from "./types";

/**
 * Centralised tool registry for the AI agent.
 *
 * Add a new tool here (and only here) to expose it to the model.
 */

export const DATA_TOOLS: Tool[] = [
  // Grounded product retrieval — F2. search_products MUST be called before
  // the model answers any price/stock/existence question (F-plan §3).
  searchProducts,
  getProduct,
  // Phase B P1 W1.1 — per-product sales history (lifetime or date-ranged).
  // Answers "how many times was this sold / when was it last sold / this
  // month's sales of X". Wraps catalog.listProductHistory (ledger).
  getProductSalesHistory,
  // Analytics (W3).
  getSalesOverview,
  getSalesTrend,
  // Phase B P1 W1.2 — explicit period-vs-prior-period comparison.
  getSalesComparison,
  getTopBrands,
  getPaymentMix,
  getLowStock,
  getTopCustomers,
  // F10.4 — individual customer lookup + ledger.
  findCustomer,
  getCustomerDetails,
  getEmployeesOnLeave,
  getAttendanceSummary,
  getSalesByEmployee,
  // F10.4 — supplier reads + tiered resolver for safe id-matching in writes.
  resolveSupplier,
  findSupplier,
  getSupplierDetails,
  getTopSuppliers,
  // Phase B P1 W1.4 / W1.5 — full supplier payment ledger + unpaid-PO filter.
  // get_supplier_details still returns the last 8 payments as part of the
  // composite card; these two tools are the "I need more" + "which PO do I
  // allocate against" counterparts.
  getSupplierPaymentHistory,
  listUnpaidPurchaseOrders,
  // Phase B P1 Wave 2 — authoritative analytics (new derived aggregates over
  // existing tables, no schema changes). Every number is server-computed.
  getInventoryValue,
  getDeadStockProducts,
  getZeroCostProducts,
  getAverageBasketSize,
  getSalesByHour,
  getSalesByDayOfWeek,
  getNewCustomers,
  getInactiveCustomers,
  getSupplierPriceHistory,
  // Phase B Final — reasoning helpers. resolve_payment_counterparty prevents
  // the Agent from fabricating supplier allocations on an ambiguous 'paid X'.
  // get_shop_pulse is the one-call attention summary used to answer broad
  // "what should I watch out for?" questions.
  resolvePaymentCounterparty,
  getShopPulse,
  // Employee resolver — tiered match for assignment flows (tasks mostly).
  resolveEmployee,
  // Tasks — full CRUD via the F5 staged-write pipeline. Reads honor the
  // caller's permission (mine:true path is safe for staff).
  listTasksTool,
  getTaskTool,
  // Notifications — READ ONLY. No send tool exists because there is no
  // stable "arbitrary message → recipient" service in the product; sending
  // flows through domain events (e.g. preview_create_task triggers the
  // task_assigned notification via the existing dispatcher).
  listNotificationsTool,
  markNotificationsReadTool,
  // Financials engine reads — the authoritative source for revenue / COGS /
  // profit / margin / money-in-out. Honor view_profit server-side.
  getFinancialsOverview,
  getPnL,
  getProductProfitability,
  getCategoryProfitability,
  getFinancialTrends,
  // Financials enumeration (needed before preview_void_*).
  listExpenses,
  listMoneyMovementsTool,
  listFinanceCategories,
  // Payroll — read-only split of finalized (in P&L) vs draft (not in P&L).
  getPayrollSummary,
  // Payroll V1 — authoritative monthly register + one-employee sheet.
  listPayrollSheet,
  getEmployeePayrollTool,
  // Receipts — read current identity settings + prepare a MANUAL WhatsApp
  // share link for a completed sale. No WhatsApp API is called.
  getReceiptSettings,
  prepareReceiptWhatsapp,
  // F10.4 — expense + purchase-order reads.
  getExpensesSummary,
  getPurchasesSummary,
  getPurchaseOrderDetails,
  getRecentPurchaseOrders,
  // F9 — unstructured company knowledge (policies, SOPs, manuals, FAQs).
  // NEVER call this for structured ERP data; the system prompt enforces
  // the ERP-vs-knowledge split.
  searchKnowledgeTool,
  // Writes — F5. These NEVER mutate; they stash a server-side pending action
  // and return a confirmation block. Actual execution: POST /api/ai/confirm.
  previewUpdateProductPrice,
  previewUpdateProductQuantity,
  previewCreateCustomer,
  // Wave 1 — catalog authoring. Makes the AI a natural-language control
  // layer for the existing catalog services (addProduct / updateProduct /
  // addBrand / addCategory). Same F5 HMAC confirmation pipeline.
  previewCreateProduct,
  previewUpdateProduct,
  previewCreateBrand,
  previewCreateCategory,
  // F10.0 — reversible operations. find_last_operation / preview_rollback.
  // Rollback execution rides the same F5 confirm pipeline.
  findLastOperation,
  previewRollback,
  previewImportRollback,
  // F10.1 — AI data import. inspect / correct / preview. Execution rides F5.
  inspectImport,
  applyImportCorrection,
  previewImport,
  // F10.3 — bulk operations. One preview per filter, F5-confirmed execution.
  previewBulkPriceUpdate,
  previewBulkQuantityUpdate,
  previewBulkThresholdUpdate,
  // Financials Phase 7-10 — staged writes for expenses, money movements,
  // tenant-custom categories, recurring generation. Same preview → confirm
  // pipeline, same HMAC/TTL, same audit path.
  previewCreateExpense,
  previewVoidExpense,
  previewCreateMoneyMovement,
  previewVoidMoneyMovement,
  previewCreateFinanceCategory,
  previewArchiveFinanceCategory,
  previewGenerateRecurring,
  // Receipt settings staged update — permission check is view_settings on
  // the confirm route; owner bypass still applies.
  previewUpdateReceiptSettings,
  // Task mutations — staged. All three require manage_tasks (see confirm
  // route's ACTION_PERMISSION); the preview tool enforces it up front too.
  previewCreateTask,
  previewUpdateTask,
  previewSetTaskStatus,
  // Payroll V1 writes — every one requires manage_payroll (enforced here AND
  // re-checked at confirm time). Compensation edits go through the versioned
  // path and do NOT retroactively rewrite finalized sheets.
  previewCalculatePayroll,
  previewFinalizePayroll,
  previewUpdateCompensation,
  previewToggleBonusEligibility,
  previewAddPayrollAdjustment,
  // Phase B P0 — purchases. Reads use existing get_purchases_summary /
  // get_recent_purchase_orders / get_purchase_order_details /
  // get_supplier_details. Writes go through the staged-write pipeline.
  listSupplierProducts,
  listProductCategories,
  previewCreatePurchase,
  previewRecordPurchasePayment,
  // Supplier Account Payment Correction — the default "paid supplier X Y"
  // flow when the user does NOT name a specific invoice. Reduces supplier
  // balance (via money_movements/supplier_payment_direct + adjustSupplierBalance)
  // without touching any PO's paid_amount.
  previewRecordSupplierAccountPayment,
];

/** Every tool the model sees — data queries + render_* composition tools. */
export const ALL_TOOLS: Tool[] = [...DATA_TOOLS, ...RENDER_TOOLS];

const BY_NAME: Record<string, Tool> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.name, t]),
);

export function toolDefinitions(): ToolDefinition[] {
  return ALL_TOOLS.map(toDefinition);
}

export { isRenderTool };

/**
 * Execute one tool call. Enforces permission + argument parsing before the
 * handler runs. Never throws — all failures are returned as `ok:false` so the
 * model sees a readable error in its next turn and can apologise or retry.
 */
export async function executeTool(
  ctx: AgentContext,
  name: string,
  rawArgs: string,
): Promise<ToolResult> {
  const tool = BY_NAME[name];
  if (!tool) return { ok: false, error: "UNKNOWN_TOOL", reason: name };

  if (tool.requiredPermission && !ctx.permissions.includes(tool.requiredPermission) && ctx.role !== "owner") {
    return {
      ok: false,
      error: "FORBIDDEN",
      reason: `Missing permission: ${tool.requiredPermission}`,
    };
  }

  let args: Record<string, unknown>;
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { ok: false, error: "INVALID_ARGS", reason: `Could not parse args for ${name}` };
  }

  try {
    return await tool.handler(toToolContext(ctx), args);
  } catch (err) {
    console.error(`[ai/tools] ${name} failed`, err);
    return {
      ok: false,
      error: "TOOL_FAILED",
      reason: err instanceof Error ? err.message : "unknown",
    };
  }
}

/** Narrow the result to the UI blocks a `render_*` tool emits. */
export function blocksFromResult(result: ToolResult): AiBlock[] | null {
  if (result.ok && "blocks" in result) return result.blocks;
  return null;
}
