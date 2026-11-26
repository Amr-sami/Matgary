// Phase B P0 — purchase + supplier-payment writes for the AI Agent.
//
// Three tools, no business logic duplicated:
//
//   • list_supplier_products
//       Read-only. Narrows product resolution to products this supplier has
//       historically sold us. Prevents the Agent from searching the entire
//       catalogue when "اللي بنجيبه من حسين" is really a 4-product shortlist.
//
//   • preview_create_purchase
//       Stages a composite create + receive + optional-payment as a single
//       F5 pending action. Executor calls the authoritative
//       createReceivedPurchaseWithOptionalPayment() orchestrator so the entire
//       flow commits or rolls back together.
//
//   • preview_record_purchase_payment
//       Stages a supplier payment against ONE specific received PO. Executor
//       wraps the authoritative recordPayment(). Never tries to allocate
//       across POs — the Agent asks the Owner which PO when more than one is
//       outstanding.
//
// All three honour the existing security surface: `requiredPermission` gates
// the preview tool, `ACTION_PERMISSION` re-checks at confirm, every repo call
// runs through `withTenant`, every write stamps an audit row through the
// executor.

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import {
  products,
  purchaseOrderItems,
  purchaseOrders,
  suppliers,
} from "@/lib/db/schema";
import { createPending } from "@/lib/ai/write/pending";
import { listCategories } from "@/lib/repo/catalog";
import { getPurchaseOrder } from "@/lib/repo/purchase-orders";
import { listPayments } from "@/lib/repo/purchase-payments";
import { getSupplier } from "@/lib/repo/suppliers";

import type { Tool } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAYMENT_METHODS = ["cash", "bank", "vfcash", "instapay", "other"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/* ───────────────────────── list_supplier_products ───────────────────────── */

export const listSupplierProducts: Tool = {
  name: "list_supplier_products",
  description:
    "List products the given supplier has historically delivered (products linked via products.supplier_id OR appearing on received POs from that supplier). Use BEFORE search_products when the user mentions both a supplier and a product. Returns ranked matches with a confidence tier (HIGH / MEDIUM / LOW / NONE). NEVER call this to invent a product — if NONE, fall back to search_products or ask the user.",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      supplierId: {
        type: "string",
        description: "UUID returned by resolve_supplier / find_supplier.",
      },
      query: {
        type: "string",
        description:
          "Optional free-text filter — product name fragment, SKU, barcode, or code (Arabic or English).",
        minLength: 1,
      },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["supplierId"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.supplierId !== "string" || !UUID.test(args.supplierId))
      return { ok: false, error: "INVALID_SUPPLIER_ID" };
    const limit =
      typeof args.limit === "number" ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 10;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const qLower = query.toLowerCase();

    const rows = await withTenant(ctx.tenantId, async (tx) => {
      // 1) Products with the explicit supplier link.
      const direct = await tx
        .select({
          id: products.id,
          name: products.name,
          sku: products.sku,
          price: products.price,
          costPrice: products.costPrice,
          quantity: products.quantity,
        })
        .from(products)
        .where(
          and(
            eq(products.tenantId, ctx.tenantId),
            eq(products.supplierId, args.supplierId as string),
            query
              ? or(
                  ilike(products.name, `%${query}%`),
                  ilike(products.sku, `%${query}%`),
                )!
              : sql`true`,
          ),
        )
        .limit(limit * 2);

      // 2) Products that appeared on any RECEIVED PO from this supplier but
      //    whose supplier_id was never backfilled. Dedup against direct.
      const seen = new Set(direct.map((r) => r.id));
      const historical = await tx
        .selectDistinctOn([purchaseOrderItems.productId], {
          id: purchaseOrderItems.productId,
        })
        .from(purchaseOrderItems)
        .innerJoin(
          purchaseOrders,
          and(
            eq(purchaseOrders.id, purchaseOrderItems.purchaseOrderId),
            eq(purchaseOrders.tenantId, ctx.tenantId),
            eq(purchaseOrders.supplierId, args.supplierId as string),
            eq(purchaseOrders.status, "received"),
          ),
        )
        .where(
          and(
            eq(purchaseOrderItems.tenantId, ctx.tenantId),
            sql`${purchaseOrderItems.productId} is not null`,
          ),
        )
        .orderBy(purchaseOrderItems.productId, desc(purchaseOrders.receivedDate))
        .limit(limit * 2);
      const historicalIds = historical
        .map((h) => h.id)
        .filter((v): v is string => !!v && !seen.has(v));
      let extra: typeof direct = [];
      if (historicalIds.length > 0) {
        extra = await tx
          .select({
            id: products.id,
            name: products.name,
            sku: products.sku,
            price: products.price,
            costPrice: products.costPrice,
            quantity: products.quantity,
          })
          .from(products)
          .where(
            and(
              eq(products.tenantId, ctx.tenantId),
              inArray(products.id, historicalIds),
              query
                ? or(
                    ilike(products.name, `%${query}%`),
                    ilike(products.sku, `%${query}%`),
                  )!
                : sql`true`,
            ),
          );
      }
      return [...direct, ...extra];
    });

    // Score using the same tiered logic as resolve_supplier so the Agent gets
    // consistent HIGH/MEDIUM/LOW/NONE semantics across resolvers.
    const scored = rows.map((r) => {
      const name = (r.name ?? "").toLowerCase().trim();
      const sku = (r.sku ?? "").toLowerCase().trim();
      let score = 0.5;
      if (query) {
        if (name === qLower || sku === qLower) score = 1.0;
        else if (name.startsWith(qLower) || sku.startsWith(qLower)) score = 0.85;
        else if (name.includes(qLower) || sku.includes(qLower)) score = 0.7;
        else score = 0.4;
      } else {
        score = 0.75; // list-mode — all results are plausible
      }
      return {
        id: r.id,
        name: r.name,
        sku: r.sku,
        price: Number(r.price),
        costPrice: r.costPrice == null ? null : Number(r.costPrice),
        quantity: r.quantity,
        score,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    let tier: "HIGH" | "MEDIUM" | "LOW" | "NONE";
    if (top.length === 0) tier = "NONE";
    else if (top[0]!.score >= 1 && top.filter((c) => c.score === top[0]!.score).length === 1)
      tier = "HIGH";
    else if (top.length === 1) tier = "MEDIUM";
    else tier = "LOW";

    return {
      ok: true,
      data: {
        supplierId: args.supplierId,
        query: query || null,
        tier,
        candidates: top,
      },
    };
  },
};

/* ───────────────────────── preview_create_purchase ──────────────────────── */

interface PurchaseItemInput {
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
  categoryId?: string;
}

function parseItem(raw: unknown): PurchaseItemInput | string {
  if (!raw || typeof raw !== "object") return "ITEM_NOT_OBJECT";
  const r = raw as Record<string, unknown>;
  const productId =
    typeof r.productId === "string" && UUID.test(r.productId) ? r.productId : null;
  const productName = typeof r.productName === "string" ? r.productName.trim() : "";
  const quantity = typeof r.quantity === "number" ? r.quantity : NaN;
  const unitCost = typeof r.unitCost === "number" ? r.unitCost : NaN;
  const categoryId =
    typeof r.categoryId === "string" && UUID.test(r.categoryId) ? r.categoryId : undefined;
  if (!productId && !productName) return "ITEM_MISSING_PRODUCT";
  if (!Number.isFinite(quantity) || quantity <= 0) return "ITEM_INVALID_QUANTITY";
  if (!Number.isFinite(unitCost) || unitCost < 0) return "ITEM_INVALID_UNIT_COST";
  // New product (no productId) MUST have a categoryId — the Agent must ask
  // the user per the Phase B spec; we do not silently fall back to "first
  // category at the branch" the way receivePurchaseOrder does.
  if (!productId && !categoryId) return "NEW_PRODUCT_NEEDS_CATEGORY";
  return { productId, productName, quantity, unitCost, categoryId };
}

export const previewCreatePurchase: Tool = {
  name: "preview_create_purchase",
  description:
    "Stage a received-purchase + optional supplier payment as ONE confirmation. Use after the user describes a purchase event (goods received, not merely ordered). Resolve supplier via resolve_supplier/find_supplier first. For each line: resolve existing products via search_products or list_supplier_products — if the product is genuinely new, pass productId=null + productName + categoryId (ASK the user for the category; do not guess). On confirm, Storo creates the PO, receives it (stock +=, cost_price updated to the new unit cost for existing products, new products materialised), and optionally records a supplier payment — all in one DB transaction. Requires `manage_purchases`.",
  requiredPermission: "manage_purchases",
  parameters: {
    type: "object",
    properties: {
      supplierId: { type: "string", description: "Resolved supplier UUID." },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description: "Existing product UUID; null for a genuinely new product.",
            },
            productName: {
              type: "string",
              description: "Name — required when productId is null OR missing.",
            },
            quantity: { type: "number", minimum: 0.0001 },
            unitCost: { type: "number", minimum: 0 },
            categoryId: {
              type: "string",
              description: "Category UUID — REQUIRED when productId is null.",
            },
          },
          required: ["productName", "quantity", "unitCost"],
          additionalProperties: false,
        },
      },
      paidNow: {
        type: "number",
        minimum: 0,
        description: "Immediate supplier payment (0 or omitted = pure credit).",
      },
      paymentMethod: {
        type: "string",
        enum: [...PAYMENT_METHODS],
        description: "Defaults to 'cash' when paidNow > 0.",
      },
      notes: { type: "string", maxLength: 500 },
    },
    required: ["supplierId", "items"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.supplierId !== "string" || !UUID.test(args.supplierId))
      return { ok: false, error: "INVALID_SUPPLIER_ID" };
    if (!Array.isArray(args.items) || args.items.length === 0)
      return { ok: false, error: "INVALID_ITEMS" };

    // Verify supplier exists in this tenant.
    const supplier = await getSupplier(ctx.tenantId, args.supplierId);
    if (!supplier) return { ok: false, error: "SUPPLIER_NOT_FOUND" };

    // Parse + validate items.
    const parsed: PurchaseItemInput[] = [];
    for (const raw of args.items) {
      const r = parseItem(raw);
      if (typeof r === "string") return { ok: false, error: r };
      parsed.push(r);
    }

    // Load display names for existing products so the preview reads naturally.
    const existingIds = parsed
      .map((p) => p.productId)
      .filter((v): v is string => !!v);
    const existingMap = new Map<
      string,
      { name: string; quantity: number; costPrice: number | null }
    >();
    if (existingIds.length > 0) {
      await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: products.id,
            name: products.name,
            quantity: products.quantity,
            costPrice: products.costPrice,
          })
          .from(products)
          .where(
            and(
              eq(products.tenantId, ctx.tenantId),
              inArray(products.id, existingIds),
            ),
          );
        for (const r of rows) {
          existingMap.set(r.id, {
            name: r.name,
            quantity: r.quantity,
            costPrice: r.costPrice == null ? null : Number(r.costPrice),
          });
        }
      });
      // Any provided productId that didn't resolve → user hallucination; refuse.
      for (const id of existingIds) {
        if (!existingMap.has(id)) return { ok: false, error: "PRODUCT_NOT_FOUND" };
      }
    }

    // Totals.
    const total =
      Math.round(parsed.reduce((s, i) => s + i.quantity * i.unitCost, 0) * 100) / 100;
    const paidNow =
      typeof args.paidNow === "number"
        ? Math.round(Math.max(0, args.paidNow) * 100) / 100
        : 0;
    if (paidNow > total + 0.001)
      return { ok: false, error: "PAID_GREATER_THAN_TOTAL" };
    const outstanding = Math.round((total - paidNow) * 100) / 100;
    const paymentMethod: PaymentMethod =
      typeof args.paymentMethod === "string" &&
      (PAYMENT_METHODS as readonly string[]).includes(args.paymentMethod)
        ? (args.paymentMethod as PaymentMethod)
        : "cash";

    // Human-readable preview lines. Flag cost updates for existing products.
    const previewLines = parsed.map((p, idx) => {
      if (p.productId) {
        const ex = existingMap.get(p.productId)!;
        const costChange =
          ex.costPrice != null && Math.abs(ex.costPrice - p.unitCost) > 0.005
            ? `  ⚠ سيتم تحديث تكلفة ${ex.name} من ${fmtMoney(ex.costPrice)} إلى ${fmtMoney(p.unitCost)}`
            : "";
        return (
          `${idx + 1}. ${ex.name} — ${p.quantity} × ${fmtMoney(p.unitCost)} = ${fmtMoney(p.quantity * p.unitCost)}` +
          (costChange ? `\n${costChange}` : "")
        );
      }
      return `${idx + 1}. جديد: ${p.productName} — ${p.quantity} × ${fmtMoney(p.unitCost)} = ${fmtMoney(p.quantity * p.unitCost)}`;
    });

    const newProductCount = parsed.filter((p) => !p.productId).length;
    const extraNote =
      newProductCount > 0 ? `\nهيضيف ${newProductCount} منتج${newProductCount === 1 ? "" : " جديد"} للكتالوج.` : "";

    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_purchase",
      params: {
        supplierId: args.supplierId,
        items: parsed,
        paidNow,
        paymentMethod,
        notes: typeof args.notes === "string" ? args.notes : null,
      },
      preview: {
        supplierId: args.supplierId,
        supplierName: supplier.name,
        itemCount: parsed.length,
        newProductCount,
        total,
        paidNow,
        outstanding,
      },
    });

    const body = [
      `المورد: ${supplier.name}`,
      ``,
      ...previewLines,
      ``,
      `إجمالي الشراء: ${fmtMoney(total)} ج.م`,
      paidNow > 0
        ? `المدفوع الآن: ${fmtMoney(paidNow)} ج.م (${paymentMethod})`
        : `بدون دفع فوري — كله هيتقيد على حساب المورد`,
      `المتبقي للمورد: ${fmtMoney(outstanding)} ج.م`,
      extraNote ? `` : "",
      extraNote,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `تسجيل شراء من ${supplier.name}`,
          summary: body,
          actionLabel: "سجّل الشراء",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};

/* ────────────────────── preview_record_purchase_payment ───────────────────── */

export const previewRecordPurchasePayment: Tool = {
  name: "preview_record_purchase_payment",
  description:
    "Stage a supplier payment against ONE specific RECEIVED purchase order. First resolve the supplier, then use get_supplier_details to see their outstanding POs. If exactly one has an outstanding balance, use its id. If multiple, ask the user which PO the payment belongs to — NEVER guess allocation. The authoritative service rejects: overpay, payments on draft/cancelled POs, fully-paid POs. Requires `manage_purchases`.",
  requiredPermission: "manage_purchases",
  parameters: {
    type: "object",
    properties: {
      purchaseOrderId: {
        type: "string",
        description: "Exact UUID of the received PO this payment settles.",
      },
      amount: { type: "number", minimum: 0.01 },
      paymentMethod: { type: "string", enum: [...PAYMENT_METHODS] },
      notes: { type: "string", maxLength: 500 },
    },
    required: ["purchaseOrderId", "amount"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.purchaseOrderId !== "string" || !UUID.test(args.purchaseOrderId))
      return { ok: false, error: "INVALID_PO_ID" };
    if (typeof args.amount !== "number" || args.amount <= 0)
      return { ok: false, error: "INVALID_AMOUNT" };

    const po = await getPurchaseOrder(ctx.tenantId, args.purchaseOrderId);
    if (!po) return { ok: false, error: "PO_NOT_FOUND" };
    if (po.status !== "received")
      return { ok: false, error: "PO_NOT_RECEIVED" };
    const remaining = Math.round((po.total - po.paidAmount) * 100) / 100;
    if (remaining <= 0) return { ok: false, error: "PO_ALREADY_PAID" };
    if (args.amount > remaining + 0.001)
      return {
        ok: false,
        error: "AMOUNT_EXCEEDS_REMAINING",
        reason: `المتبقي على هذه الفاتورة ${fmtMoney(remaining)} ج.م فقط.`,
      };

    const paymentMethod: PaymentMethod =
      typeof args.paymentMethod === "string" &&
      (PAYMENT_METHODS as readonly string[]).includes(args.paymentMethod)
        ? (args.paymentMethod as PaymentMethod)
        : "cash";
    const amount = Math.round(args.amount * 100) / 100;
    const newRemaining = Math.round((remaining - amount) * 100) / 100;

    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "record_purchase_payment",
      params: {
        purchaseOrderId: args.purchaseOrderId,
        amount,
        paymentMethod,
        notes: typeof args.notes === "string" ? args.notes : null,
      },
      preview: {
        purchaseOrderId: args.purchaseOrderId,
        supplierId: po.supplierId,
        supplierName: po.supplierName,
        amount,
        remainingAfter: newRemaining,
        paymentMethod,
      },
    });

    const body = [
      `المورد: ${po.supplierName}`,
      `فاتورة: ${po.id.slice(0, 8).toUpperCase()}`,
      `إجمالي الفاتورة: ${fmtMoney(po.total)} ج.م`,
      `المدفوع قبل العملية: ${fmtMoney(po.paidAmount)} ج.م`,
      `الدفعة الحالية: ${fmtMoney(amount)} ج.م (${paymentMethod})`,
      `المتبقي بعد الدفع: ${fmtMoney(newRemaining)} ج.م`,
    ].join("\n");

    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `دفعة لـ ${po.supplierName}`,
          summary: body,
          actionLabel: "سجّل الدفعة",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};

/* ──────────────── preview_record_supplier_account_payment ───────────────── */

export const previewRecordSupplierAccountPayment: Tool = {
  name: "preview_record_supplier_account_payment",
  description:
    "Stage an ACCOUNT-LEVEL supplier payment. This is the DEFAULT interpretation of 'دفعت لحسين X' / 'paid supplier X amount' when the user did NOT name a specific invoice/PO. The payment reduces the supplier's net outstanding balance (`suppliers.balance`) but does NOT allocate to any particular PO — per-invoice outstanding stays visible as untied credit, which the owner can reconcile later if they want. Use preview_record_purchase_payment INSTEAD when the user explicitly names an invoice/PO. Requires `manage_purchases`. Preconditions: amount > 0, amount <= current supplier.balance (Storo has no supplier-credit concept yet, so paying more than owed is rejected).",
  requiredPermission: "manage_purchases",
  parameters: {
    type: "object",
    properties: {
      supplierId: {
        type: "string",
        description:
          "Supplier UUID. Resolve first via resolve_payment_counterparty + find_supplier/resolve_supplier.",
      },
      amount: { type: "number", minimum: 0.01 },
      paymentMethod: { type: "string", enum: [...PAYMENT_METHODS] },
      notes: { type: "string", maxLength: 500 },
    },
    required: ["supplierId", "amount"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (typeof args.supplierId !== "string" || !UUID.test(args.supplierId))
      return { ok: false, error: "INVALID_SUPPLIER_ID" };
    if (typeof args.amount !== "number" || args.amount <= 0)
      return { ok: false, error: "INVALID_AMOUNT" };

    // Load current supplier for the preview (name, balance) — tenant-scoped.
    const [sup] = await withTenant(ctx.tenantId, (tx) =>
      tx
        .select({
          id: suppliers.id,
          name: suppliers.name,
          balance: suppliers.balance,
        })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.id, args.supplierId as string)))
        .limit(1),
    );
    if (!sup) return { ok: false, error: "SUPPLIER_NOT_FOUND" };

    const balanceBefore = Number(sup.balance ?? 0);
    const amount = Math.round(args.amount * 100) / 100;
    if (amount > balanceBefore + 0.001)
      return {
        ok: false,
        error: "AMOUNT_EXCEEDS_BALANCE",
        reason: `الرصيد المستحق للمورد ${fmtMoney(balanceBefore)} ج.م فقط — دفع مبلغ أكبر من ده مش مدعوم (مفيش تسجيل رصيد دائن للمورد في الموديل الحالي).`,
      };
    const balanceAfter = Math.round((balanceBefore - amount) * 100) / 100;

    const paymentMethod: PaymentMethod =
      typeof args.paymentMethod === "string" &&
      (PAYMENT_METHODS as readonly string[]).includes(args.paymentMethod)
        ? (args.paymentMethod as PaymentMethod)
        : "cash";

    const token = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "record_supplier_account_payment",
      params: {
        supplierId: args.supplierId,
        amount,
        paymentMethod,
        notes: typeof args.notes === "string" ? args.notes : null,
      },
      preview: {
        supplierId: args.supplierId,
        supplierName: sup.name,
        amount,
        balanceBefore,
        balanceAfter,
        paymentMethod,
      },
    });

    const body = [
      `المورد: ${sup.name}`,
      `الرصيد المستحق قبل الدفعة: ${fmtMoney(balanceBefore)} ج.م`,
      `الدفعة: ${fmtMoney(amount)} ج.م (${paymentMethod})`,
      `الرصيد المستحق بعد الدفعة: ${fmtMoney(balanceAfter)} ج.م`,
      `(الدفعة بتخصم من رصيد الحساب ككل — مش بتترحل على فاتورة محددة)`,
    ].join("\n");

    return {
      ok: true,
      blocks: [
        {
          kind: "confirmation",
          title: `دفعة لحساب ${sup.name}`,
          summary: body,
          actionLabel: "سجّل الدفعة",
          token: token.token,
          expiresAt: token.expiresAt,
        },
      ],
    };
  },
};

/* ───────────────────────── list_product_categories ────────────────────── */

export const listProductCategories: Tool = {
  name: "list_product_categories",
  description:
    "List the catalogue categories for products (Arabic + English labels), e.g. 'ساعات', 'عطور', 'نظارات'. Call this when a user mentions a category by name — a new-product line in preview_create_purchase needs the category UUID, not the name. Returns [{ id, label, key }] — use the label to disambiguate against the user's phrasing.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async handler(ctx) {
    const cats = await listCategories(ctx.tenantId, null);
    return {
      ok: true,
      data: {
        categories: cats.map((c) => ({ id: c.id, label: c.label, key: c.key })),
      },
    };
  },
};

// Silence unused-imports lint when future refactors drop one of these primitives.
void listPayments;
void suppliers;
