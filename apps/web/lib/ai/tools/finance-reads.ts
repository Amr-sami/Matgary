// Read-only Financials tools. Thin wrappers over the authoritative services
// so the Agent can enumerate expenses / money movements / categories
// (needed before any preview_* staged write).

import {
  DEFAULT_REPORTING_TZ,
  isDatePresetKey,
  resolvePreset,
  type DatePresetKey,
} from "@/lib/finance/dates";
import { listFinanceExpenses } from "@/lib/finance/expense-mutations";
import { listMoneyMovements } from "@/lib/finance/money-movement-mutations";
import { listCategoriesTree } from "@/lib/finance/categories";

import type { Tool } from "./types";

function parsePreset(v: unknown): DatePresetKey {
  return isDatePresetKey(v) ? v : "this_month";
}

/* ───────────────────────────── list_expenses ───────────────────────────── */

export const listExpenses: Tool = {
  name: "list_expenses",
  description:
    "List posted (default) / voided / all expenses for a period. Returns rows with id, title, amount, date, categoryId + category names, paymentMethod, status. Paginated by server; limit default 20. Use before previewing a void.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: {
        type: "string",
        enum: [
          "today",
          "yesterday",
          "this_week",
          "last_week",
          "this_month",
          "last_month",
          "this_year",
          "last_7_days",
          "last_30_days",
          "custom",
        ],
      },
      from: { type: "string" },
      to: { type: "string" },
      status: { type: "string", enum: ["posted", "voided", "any"] },
      categoryId: { type: "string" },
      paymentMethod: { type: "string" },
      search: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const preset = parsePreset(args.preset);
    const period = resolvePreset(preset, {
      tz: DEFAULT_REPORTING_TZ,
      customFrom: typeof args.from === "string" ? args.from : undefined,
      customTo: typeof args.to === "string" ? args.to : undefined,
    });
    const status = args.status === "voided" || args.status === "any" ? args.status : "posted";
    const limit = typeof args.limit === "number" ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 20;
    const page = await listFinanceExpenses(ctx.tenantId, {
      from: period.from,
      to: period.to,
      status,
      categoryId: typeof args.categoryId === "string" ? args.categoryId : undefined,
      paymentMethod: typeof args.paymentMethod === "string" ? args.paymentMethod : undefined,
      search: typeof args.search === "string" ? args.search : undefined,
      limit,
      cursor: null,
    });
    return { ok: true, data: { preset, rows: page.data, nextCursor: page.nextCursor ?? null } };
  },
};

/* ────────────────────────── list_money_movements ───────────────────────── */

export const listMoneyMovementsTool: Tool = {
  name: "list_money_movements",
  description:
    "List money movements (owner deposits/withdrawals, loans, transfers, …) for a period. These are NOT P&L. Returns id, kind, direction, amount, occurredAt, description.",
  requiredPermission: "view_financials",
  parameters: {
    type: "object",
    properties: {
      preset: {
        type: "string",
        enum: [
          "today",
          "yesterday",
          "this_week",
          "last_week",
          "this_month",
          "last_month",
          "this_year",
          "last_7_days",
          "last_30_days",
          "custom",
        ],
      },
      from: { type: "string" },
      to: { type: "string" },
      kind: { type: "string" },
      status: { type: "string", enum: ["active", "voided", "any"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const preset = parsePreset(args.preset);
    const period = resolvePreset(preset, {
      tz: DEFAULT_REPORTING_TZ,
      customFrom: typeof args.from === "string" ? args.from : undefined,
      customTo: typeof args.to === "string" ? args.to : undefined,
    });
    const status = args.status === "voided" || args.status === "any" ? args.status : "active";
    const limit = typeof args.limit === "number" ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 20;
    const page = await listMoneyMovements(ctx.tenantId, {
      from: period.from,
      to: period.to,
      kind: typeof args.kind === "string" ? (args.kind as never) : undefined,
      status,
      limit,
      cursor: null,
    });
    return { ok: true, data: { preset, rows: page.data, nextCursor: page.nextCursor ?? null } };
  },
};

/* ───────────────────────── list_finance_categories ─────────────────────── */

export const listFinanceCategories: Tool = {
  name: "list_finance_categories",
  description:
    "Return the tenant's financial category tree (system + tenant-custom, non-archived). Each node: id, parentId, slug, nameEn, nameAr, kind (opex/other_income/other_expense), isSystem, children. The Agent must use these ids when previewing an expense create — NEVER invent a categoryId.",
  requiredPermission: "view_financials",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async handler(ctx) {
    const tree = await listCategoriesTree(ctx.tenantId);
    return { ok: true, data: { tree } };
  },
};
