// Agent tools for Financials MUTATIONS — expenses, money movements,
// recurring templates, categories. Staged, HMAC-signed, confirmed via
// /api/ai/confirm. Underlying execution reuses the existing lib/finance
// mutations (createFinanceExpense, voidFinanceExpense,
// createMoneyMovement, voidMoneyMovement, createCustomCategory,
// archiveCategory, materializeDueRecurringExpenses) — this file adds ZERO
// new business logic.

import { MONEY_MOVEMENT_KINDS } from "@/lib/finance/money-movement-mutations";

import { tr } from "../i18n";
import { createPending } from "../write/pending";
import type { Tool } from "./types";
import type { AiBlock, Locale } from "../responses";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO day — tolerates 'YYYY-MM-DD' which the executor pins to local noon.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const latin = v.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/,/g, ".");
    const n = Number(latin);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseIsoDay(v: unknown): string | null {
  if (typeof v === "string" && ISO_DAY.test(v)) return v;
  return null;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ───────────────────────── preview_create_expense ──────────────────────── */

export const previewCreateExpense: Tool = {
  name: "preview_create_expense",
  description:
    "PREVIEW the creation of a new posted expense. Requires a title, positive amount, ISO date (YYYY-MM-DD) and categoryId (uuid from list_finance_categories). Optional supplierId — if the user NAMES a supplier (e.g. 'for ABC Supplies'), call resolve_supplier FIRST and use the HIGH-tier id; NEVER invent a supplierId. Optional paymentMethod, referenceNumber, note. Returns a confirmation block the user taps to execute. NEVER writes directly.",
  requiredPermission: "manage_expenses",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      amount: {
        type: "number",
        description: "EGP, strictly positive.",
      },
      date: { type: "string", description: "'YYYY-MM-DD'." },
      categoryId: { type: "string", description: "uuid from list_finance_categories." },
      paymentMethod: {
        type: "string",
        enum: ["cash", "instapay", "wallet", "card", "other"],
      },
      referenceNumber: { type: "string", maxLength: 80 },
      note: { type: "string", maxLength: 500 },
      supplierId: { type: "string" },
    },
    required: ["title", "amount", "date", "categoryId"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const title = String(args.title ?? "").trim();
    const amount = parseAmount(args.amount);
    const date = parseIsoDay(args.date);
    const categoryId = typeof args.categoryId === "string" && UUID_SHAPE.test(args.categoryId)
      ? args.categoryId
      : null;
    if (!title) return { ok: false, error: "INVALID_PARAMS", reason: "title is required" };
    if (!amount) return { ok: false, error: "INVALID_PARAMS", reason: "amount must be a positive number" };
    if (!date) return { ok: false, error: "INVALID_PARAMS", reason: "date must be 'YYYY-MM-DD'" };
    if (!categoryId) return { ok: false, error: "INVALID_PARAMS", reason: "categoryId must be a uuid from list_finance_categories" };

    const paymentMethod = typeof args.paymentMethod === "string" ? args.paymentMethod : null;
    const referenceNumber = typeof args.referenceNumber === "string" ? args.referenceNumber : null;
    const note = typeof args.note === "string" ? args.note : null;
    const supplierId = typeof args.supplierId === "string" && UUID_SHAPE.test(args.supplierId)
      ? args.supplierId
      : null;

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title,
        amount,
        date,
        categoryId,
        paymentMethod,
        referenceNumber,
        note,
        supplierId,
      },
      preview: {
        locale: ctx.locale ?? "en",
        title,
        amount,
        date,
      },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.expense.title", locale, { title }),
      summary: `${title} · ${fmtMoney(amount)} EGP · ${date}`,
      actionLabel: tr("write.expense.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ───────────────────────── preview_void_expense ────────────────────────── */

export const previewVoidExpense: Tool = {
  name: "preview_void_expense",
  description:
    "PREVIEW voiding an existing posted expense by id. Voided expenses are excluded from P&L (soft delete). Returns a confirmation block.",
  requiredPermission: "manage_expenses",
  parameters: {
    type: "object",
    properties: {
      expense_id: { type: "string", description: "uuid of the expense to void." },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["expense_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.expense_id === "string" && UUID_SHAPE.test(args.expense_id)
      ? args.expense_id
      : null;
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "expense_id must be a uuid" };
    const reason = typeof args.reason === "string" ? args.reason : null;

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "void_expense",
      params: { expenseId: id, reason },
      preview: { locale: ctx.locale ?? "en", expenseId: id, reason },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.voidExpense.title", locale),
      summary: tr("write.voidExpense.summary", locale, { id: id.slice(0, 8) }),
      actionLabel: tr("write.voidExpense.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ─────────────────── preview_create_money_movement ─────────────────────── */

export const previewCreateMoneyMovement: Tool = {
  name: "preview_create_money_movement",
  description:
    "PREVIEW the creation of a new money movement (owner deposit/withdrawal, loan received/repaid, cash transfer, supplier direct payment, customer deposit, other). CRITICAL: money movements are NOT P&L — they track cash flow only. Owner deposit is NOT revenue; owner withdrawal is NOT an expense; loan principal is NOT P&L. Returns a confirmation block.",
  requiredPermission: "manage_money_movements",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...MONEY_MOVEMENT_KINDS] },
      amount: { type: "number", description: "EGP, strictly positive." },
      occurredOn: { type: "string", description: "'YYYY-MM-DD'." },
      description: { type: "string", maxLength: 500 },
      paymentMethod: { type: "string", enum: ["cash", "instapay", "wallet", "card", "other"] },
    },
    required: ["kind", "amount", "occurredOn"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const kind = typeof args.kind === "string" && (MONEY_MOVEMENT_KINDS as readonly string[]).includes(args.kind)
      ? args.kind
      : null;
    const amount = parseAmount(args.amount);
    const date = parseIsoDay(args.occurredOn);
    if (!kind) return { ok: false, error: "INVALID_PARAMS", reason: "kind is required" };
    if (!amount) return { ok: false, error: "INVALID_PARAMS", reason: "amount must be a positive number" };
    if (!date) return { ok: false, error: "INVALID_PARAMS", reason: "occurredOn must be 'YYYY-MM-DD'" };

    const description = typeof args.description === "string" ? args.description : null;
    const paymentMethod = typeof args.paymentMethod === "string" ? args.paymentMethod : null;

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_money_movement",
      params: { kind, amount, occurredOn: date, description, paymentMethod },
      preview: { locale: ctx.locale ?? "en", kind, amount, date },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.moneyMovement.title", locale),
      summary: `${kind} · ${fmtMoney(amount)} EGP · ${date}`,
      actionLabel: tr("write.moneyMovement.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ─────────────────── preview_void_money_movement ───────────────────────── */

export const previewVoidMoneyMovement: Tool = {
  name: "preview_void_money_movement",
  description:
    "PREVIEW voiding an existing money movement by id (soft delete).",
  requiredPermission: "manage_money_movements",
  parameters: {
    type: "object",
    properties: {
      movement_id: { type: "string" },
      reason: { type: "string", maxLength: 500 },
    },
    required: ["movement_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.movement_id === "string" && UUID_SHAPE.test(args.movement_id)
      ? args.movement_id
      : null;
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "movement_id must be a uuid" };
    const reason = typeof args.reason === "string" ? args.reason : null;

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "void_money_movement",
      params: { movementId: id, reason },
      preview: { locale: ctx.locale ?? "en", movementId: id },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.voidMoneyMovement.title", locale),
      summary: tr("write.voidMoneyMovement.summary", locale, { id: id.slice(0, 8) }),
      actionLabel: tr("write.voidMoneyMovement.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ─────────────────── preview_create_finance_category ───────────────────── */

export const previewCreateFinanceCategory: Tool = {
  name: "preview_create_finance_category",
  description:
    "PREVIEW the creation of a tenant-custom financial category under an existing parent GROUP (must be a top-level group, not a subcategory). Slug must be [a-z0-9-]{3,32}; names in English and Arabic.",
  requiredPermission: "manage_expense_categories",
  parameters: {
    type: "object",
    properties: {
      parentId: { type: "string" },
      slug: { type: "string" },
      nameEn: { type: "string", minLength: 1, maxLength: 60 },
      nameAr: { type: "string", minLength: 1, maxLength: 60 },
    },
    required: ["parentId", "slug", "nameEn", "nameAr"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const parentId = typeof args.parentId === "string" && UUID_SHAPE.test(args.parentId)
      ? args.parentId
      : null;
    const slug = typeof args.slug === "string" && /^[a-z0-9-]{3,32}$/.test(args.slug)
      ? args.slug
      : null;
    const nameEn = typeof args.nameEn === "string" ? args.nameEn.trim() : "";
    const nameAr = typeof args.nameAr === "string" ? args.nameAr.trim() : "";
    if (!parentId) return { ok: false, error: "INVALID_PARAMS", reason: "parentId must be a uuid of a top-level group" };
    if (!slug) return { ok: false, error: "INVALID_PARAMS", reason: "slug must match [a-z0-9-]{3,32}" };
    if (!nameEn || !nameAr) return { ok: false, error: "INVALID_PARAMS", reason: "nameEn and nameAr are required" };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_finance_category",
      params: { parentId, slug, nameEn, nameAr },
      preview: { locale: ctx.locale ?? "en", nameEn, nameAr, slug },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.financeCategory.title", locale),
      summary: `${nameAr} / ${nameEn} · ${slug}`,
      actionLabel: tr("write.financeCategory.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ─────────────────── preview_archive_finance_category ──────────────────── */

export const previewArchiveFinanceCategory: Tool = {
  name: "preview_archive_finance_category",
  description:
    "PREVIEW archiving a tenant-custom financial category. Fails server-side if any live (posted) expense still references the category. System categories cannot be archived.",
  requiredPermission: "manage_expense_categories",
  parameters: {
    type: "object",
    properties: {
      category_id: { type: "string" },
    },
    required: ["category_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.category_id === "string" && UUID_SHAPE.test(args.category_id)
      ? args.category_id
      : null;
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "category_id must be a uuid" };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "archive_finance_category",
      params: { categoryId: id },
      preview: { locale: ctx.locale ?? "en", categoryId: id },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.archiveFinanceCategory.title", locale),
      summary: tr("write.archiveFinanceCategory.summary", locale, { id: id.slice(0, 8) }),
      actionLabel: tr("write.archiveFinanceCategory.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ───────────────────── preview_generate_recurring ──────────────────────── */

export const previewGenerateRecurring: Tool = {
  name: "preview_generate_recurring",
  description:
    "PREVIEW generating all recurring-expense templates that are due now. Idempotent (DB-enforced via partial UNIQUE). Returns a confirmation block; execution runs materializeDueRecurringExpenses.",
  requiredPermission: "manage_recurring_expenses",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async handler(ctx) {
    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "generate_recurring",
      params: {},
      preview: { locale: ctx.locale ?? "en" },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.generateRecurring.title", locale),
      summary: tr("write.generateRecurring.summary", locale),
      actionLabel: tr("write.generateRecurring.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};
