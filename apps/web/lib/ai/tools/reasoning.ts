// Phase B — Agent reasoning tools.
//
// Two tools live here, both pure reads:
//
//   1. resolve_payment_counterparty
//      Unified lookup across suppliers AND team members (and a lightweight
//      heuristic for expense-recipient). Prevents the Agent from
//      silently assuming that "دفعت لحسين" means a supplier payment when
//      Hussein might just as well be an employee or an ad-hoc vendor.
//
//      Every mutation path (supplier payment, payroll, expense) still goes
//      through its own staged-write tool after the counterparty is known —
//      this tool does NOT stage anything.
//
//   2. get_shop_pulse
//      Composite read that stitches together the authoritative signals the
//      shop owner cares about when they ask "في حاجة محتاجة آخد بالي منها؟":
//      low stock, dead stock, zero-cost products, inactive customers, total
//      supplier payable, and current-vs-prior sales delta. Every number is
//      server-computed by an existing helper; this tool is pure orchestration.
//
// Neither tool mutates. Neither tool invents data. Both honour tenant +
// permission in the same way as every other Agent read.

import { and, eq, ilike, or, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { suppliers, tenantMembers, users } from "@/lib/db/schema";
import {
  computeDeadStockProducts,
  computeInactiveCustomers,
  computeInventoryValue,
  computeZeroCostProducts,
} from "@/lib/repo/analytics-wave2";
import { loadCompareReport } from "@/lib/repo/insights-deep";
import { listProducts } from "@/lib/repo/catalog";

import type { Tool } from "./types";

/* ───────────────────── resolve_payment_counterparty ─────────────────── */

type Tier = "HIGH" | "MEDIUM" | "LOW" | "NONE";

interface SupplierCandidate {
  id: string;
  name: string;
  phone: string | null;
  outstandingBalance: number;
  score: number;
}

interface EmployeeCandidate {
  userId: string;
  name: string | null;
  role: string;
  score: number;
}

function scoreName(name: string, query: string): number {
  const a = name.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (a === q) return 1.0;
  if (a.startsWith(q)) return 0.85;
  if (a.split(/\s+/).some((p) => p === q)) return 0.9;
  if (a.includes(q)) return 0.6;
  return 0.4;
}

function tierOf(cands: Array<{ score: number }>): Tier {
  if (cands.length === 0) return "NONE";
  const top = cands[0]!.score;
  if (top >= 1.0 && cands.filter((c) => c.score === top).length === 1) return "HIGH";
  if (cands.length === 1) return "MEDIUM";
  return "LOW";
}

export const resolvePaymentCounterparty: Tool = {
  name: "resolve_payment_counterparty",
  description:
    "Disambiguate a 'paid X' / 'دفعت لX' event by searching BOTH the supplier roster and the team roster in one call. Returns a classification the Agent must use to pick the right flow: supplier_payment (preview_record_purchase_payment), employee_payroll (payroll flow — outside Agent writes in this phase), or expense (preview_create_expense after category resolution). When BOTH a supplier AND an employee match the name, classification='ambiguous' and the Agent MUST ask the user which flow to follow. NEVER call a preview_* mutation tool for a payment event without resolving the counterparty first.",
  requiredPermission: "view_suppliers",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        description:
          "The name / phone fragment the user said. Case-insensitive. Arabic + English both work.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Max candidates per bucket (default 5).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const q = typeof args.query === "string" ? args.query.trim() : "";
    if (!q) return { ok: false, error: "EMPTY_QUERY" };
    const limit =
      typeof args.limit === "number"
        ? Math.min(10, Math.max(1, Math.floor(args.limit)))
        : 5;
    const pattern = `%${q}%`;
    const qLower = q.toLowerCase();

    return withTenant(ctx.tenantId, async (tx) => {
      // ── supplier bucket
      const supplierRows = await tx
        .select({
          id: suppliers.id,
          name: suppliers.name,
          phone: suppliers.phone,
          balance: suppliers.balance,
        })
        .from(suppliers)
        .where(
          and(
            eq(suppliers.tenantId, ctx.tenantId),
            or(ilike(suppliers.name, pattern), ilike(suppliers.phone, pattern)),
          ),
        )
        .limit(limit * 2);

      const supplierCands: SupplierCandidate[] = supplierRows
        .map((r) => ({
          id: r.id,
          name: r.name,
          phone: r.phone,
          outstandingBalance: Number(r.balance ?? 0),
          score: scoreName(r.name ?? "", qLower),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const supplierTier = tierOf(supplierCands);

      // ── employee bucket
      const empRows = await tx
        .select({
          userId: users.id,
          name: users.name,
          displayName: tenantMembers.displayName,
          role: tenantMembers.role,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(
          and(
            eq(tenantMembers.tenantId, ctx.tenantId),
            or(
              sql`lower(${users.name}) like ${pattern.toLowerCase()}`,
              sql`lower(${tenantMembers.displayName}) like ${pattern.toLowerCase()}`,
            ),
          ),
        )
        .limit(limit * 2);
      const employeeCands: EmployeeCandidate[] = empRows
        .map((r) => {
          const effective = r.displayName ?? r.name ?? "";
          return {
            userId: r.userId,
            name: effective || null,
            role: r.role,
            score: scoreName(effective, qLower),
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const employeeTier = tierOf(employeeCands);

      // ── classification
      const supplierStrong = supplierTier === "HIGH" || supplierTier === "MEDIUM";
      const employeeStrong = employeeTier === "HIGH" || employeeTier === "MEDIUM";

      let classification:
        | "supplier_payment"
        | "employee_payroll"
        | "ambiguous"
        | "no_match";
      let reason: string;

      if (supplierStrong && employeeStrong) {
        classification = "ambiguous";
        reason =
          "Name matches BOTH a supplier and a team member — ask the user which flow (supplier payment vs payroll/salary) applies before taking any action.";
      } else if (supplierStrong) {
        classification = "supplier_payment";
        reason =
          "Name resolves to a supplier. Use preview_record_purchase_payment. First call list_unpaid_purchase_orders(supplierId) to pick an allocation target — never silently pick the oldest.";
      } else if (employeeStrong) {
        classification = "employee_payroll";
        reason =
          "Name resolves to a team member. There is no direct 'pay employee' Agent write in this phase; payments to employees are handled via the Payroll V1 flow (preview_calculate_payroll → preview_finalize_payroll). If the user truly wants an ad-hoc bonus/deduction row, use preview_add_payroll_adjustment.";
      } else {
        classification = "no_match";
        reason =
          "No supplier or team member matched. This may be a third-party expense (vendor, landlord, utility). Ask the user for the category and use preview_create_expense — never silently create a supplier.";
      }

      return {
        ok: true,
        data: {
          query: q,
          classification,
          reason,
          supplier: { tier: supplierTier, candidates: supplierCands },
          employee: { tier: employeeTier, candidates: employeeCands },
        },
      };
    });
  },
};

/* ──────────────────────────── get_shop_pulse ────────────────────────── */

export interface ShopPulseSignal {
  key: string;
  severity: "info" | "attention" | "high";
  count: number;
  message_ar: string;
  message_en: string;
  /** Up to 5 example rows the Agent can quote verbatim. Never required —
   *  the Agent should pick one or two, not dump the whole list. */
  examples: Array<Record<string, unknown>>;
  /** Tool the Agent should call for the full detail. */
  drillDownTool: string;
}

export interface ShopPulseResult {
  generatedAt: string;
  windowDays: number;
  currency: "EGP";
  signals: ShopPulseSignal[];
}

/**
 * One-stop attention summary. Pure orchestration over existing read tools —
 * no new SQL, no new schema, no new business logic. The Agent should call
 * this whenever the user asks a broad "what should I pay attention to?"
 * question and then (a) pick 2–3 signals to describe and (b) suggest an
 * appropriate drill-down tool for each.
 *
 * Signals are intentionally labelled severity 'info' / 'attention' / 'high':
 *   'info'       = known fact, no immediate action required.
 *   'attention'  = worth reviewing; non-urgent.
 *   'high'       = material enough that the owner usually wants to know now.
 *
 * All thresholds are *defaults* — the Agent can still drill down with its
 * own params (e.g. preferred dead-stock days) via the referenced drilldown
 * tool.
 */
export const getShopPulse: Tool = {
  name: "get_shop_pulse",
  description:
    "Composite attention summary — stitches together low stock, dead stock (default 60d), zero-cost products, inactive customers (default 60d), total supplier payable, and current-vs-prior-month sales delta into ONE server-computed snapshot. Use for broad 'في حاجة محتاجة آخد بالي منها؟', 'what should I pay attention to?', 'anything I should know?' questions. Returns signals with severity (info/attention/high), counts, and a recommended drill-down tool per signal. The Agent should pick the top 2–3 signals to surface and suggest each drill-down — do NOT dump all signals.",
  requiredPermission: "view_insights",
  parameters: {
    type: "object",
    properties: {
      window_days: {
        type: "integer",
        minimum: 7,
        maximum: 365,
        description:
          "Threshold in days for 'dead stock' and 'inactive customer' signals (default 60).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const windowDays =
      typeof args.window_days === "number" && args.window_days >= 7
        ? Math.floor(args.window_days)
        : 60;

    // Run the sub-queries in parallel — they're all independent, tenant-scoped,
    // and read-only. This keeps the one-tool-call user experience snappy.
    const [
      lowStock,
      dead,
      zeroCost,
      inactive,
      inventorySnapshot,
      salesCompare,
    ] = await Promise.all([
      // `listProducts` returns the raw repo shape; the derived in/out-of-stock
      // flags live in the Agent product-tool layer. Compute them here so the
      // pulse signal fires when quantity <= lowStockThreshold.
      listProducts(ctx.tenantId, null).then((rows) =>
        rows
          .filter((p) => p.quantity <= p.lowStockThreshold)
          .map((p) => ({
            id: p.id,
            name: p.name,
            quantity: p.quantity,
            lowStockThreshold: p.lowStockThreshold,
            outOfStock: p.quantity === 0,
          })),
      ),
      computeDeadStockProducts(ctx.tenantId, {
        thresholdDays: windowDays,
        limit: 25,
      }),
      computeZeroCostProducts(ctx.tenantId, { kind: "any", limit: 25 }),
      computeInactiveCustomers(ctx.tenantId, {
        thresholdDays: windowDays,
        limit: 25,
      }),
      computeInventoryValue(ctx.tenantId, {}),
      (async () => {
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - 30);
        try {
          return await loadCompareReport(
            ctx.tenantId,
            { from: start, to: now },
            null,
          );
        } catch {
          // Compare can throw on tenants with no sales at all; treat as "no
          // comparable trend" rather than failing the whole pulse.
          return null;
        }
      })(),
    ]);

    const signals: ShopPulseSignal[] = [];

    if (lowStock.length > 0) {
      const outOfStock = lowStock.filter((p) => p.outOfStock).length;
      signals.push({
        key: "low_or_out_of_stock",
        severity: outOfStock >= 5 ? "high" : "attention",
        count: lowStock.length,
        message_ar: `${lowStock.length} منتج تحت حد التنبيه أو نافد — منهم ${outOfStock} خلصوا بالكامل.`,
        message_en: `${lowStock.length} products at or below reorder threshold — ${outOfStock} are completely out.`,
        examples: lowStock.slice(0, 5).map((p) => ({
          productId: p.id,
          name: p.name,
          quantity: p.quantity,
          lowStockThreshold: p.lowStockThreshold,
          outOfStock: p.outOfStock,
        })),
        drillDownTool: "get_low_stock",
      });
    }

    if (dead.rows.length > 0) {
      signals.push({
        key: "dead_stock",
        severity: dead.tiedUpValue >= 10_000 ? "high" : "attention",
        count: dead.totalCount,
        message_ar: `${dead.totalCount} منتج مش بيتحرك من ${windowDays} يوم (${dead.neverSoldCount} عمرهم ما اتباعوا). قيمة البضاعة النايمة ≈ ${dead.tiedUpValue.toLocaleString("en-US")} جنيه.`,
        message_en: `${dead.totalCount} products unsold for ${windowDays}+ days (${dead.neverSoldCount} never sold). Tied-up value ≈ EGP ${dead.tiedUpValue.toLocaleString("en-US")}.`,
        examples: dead.rows.slice(0, 5).map((r) => ({
          productId: r.productId,
          productName: r.productName,
          quantity: r.quantity,
          classification: r.classification,
          daysSinceLastSale: r.daysSinceLastSale,
        })),
        drillDownTool: "get_dead_stock_products",
      });
    }

    if (zeroCost.totalCount > 0) {
      signals.push({
        key: "zero_cost",
        severity: zeroCost.totalCount >= 10 ? "attention" : "info",
        count: zeroCost.totalCount,
        message_ar: `${zeroCost.totalCount} منتج من غير تكلفة شراء محفوظة (${zeroCost.nullCostCount} فاضية و${zeroCost.zeroCostCount} متسجلة صفر). الربح مش هيطلع صح عليهم.`,
        message_en: `${zeroCost.totalCount} products with missing cost (${zeroCost.nullCostCount} unset, ${zeroCost.zeroCostCount} explicitly zero). Profit numbers will be wrong for these.`,
        examples: zeroCost.rows.slice(0, 5).map((r) => ({
          productId: r.productId,
          productName: r.productName,
          kind: r.kind,
          sellingPrice: r.sellingPrice,
        })),
        drillDownTool: "get_zero_cost_products",
      });
    }

    if (inactive.count > 0) {
      signals.push({
        key: "inactive_customers",
        severity: inactive.count >= 10 ? "attention" : "info",
        count: inactive.count,
        message_ar: `${inactive.count} عميل مبقالوش شراء من أكتر من ${windowDays} يوم.`,
        message_en: `${inactive.count} customers inactive for ${windowDays}+ days.`,
        examples: inactive.rows.slice(0, 5).map((r) => ({
          customerPhone: r.customerPhone,
          customerName: r.customerName,
          daysSinceLastPurchase: r.daysSinceLastPurchase,
          lifetimeValue: r.lifetimeValue,
        })),
        drillDownTool: "get_inactive_customers",
      });
    }

    // Supplier payable (sum of balances across every supplier) — served from
    // the authoritative `suppliers.balance` column.
    const payable = await withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select({
          total: sql<string>`coalesce(sum(${suppliers.balance}), 0)::text`,
          count: sql<number>`sum(case when ${suppliers.balance}::numeric > 0 then 1 else 0 end)::int`,
        })
        .from(suppliers)
        .where(eq(suppliers.tenantId, ctx.tenantId));
      return {
        total: Number(row?.total ?? 0),
        suppliersOwed: Number(row?.count ?? 0),
      };
    });
    if (payable.total > 0) {
      signals.push({
        key: "supplier_payable",
        severity: payable.total >= 50_000 ? "high" : "attention",
        count: payable.suppliersOwed,
        message_ar: `إجمالي ديون للموردين ≈ ${payable.total.toLocaleString("en-US")} جنيه على ${payable.suppliersOwed} مورد.`,
        message_en: `Supplier payable ≈ EGP ${payable.total.toLocaleString("en-US")} across ${payable.suppliersOwed} supplier(s).`,
        examples: [],
        drillDownTool: "get_top_suppliers",
      });
    }

    if (salesCompare && salesCompare.totals.previous > 0) {
      const g = salesCompare.totals.growth;
      if (Math.abs(g) >= 10) {
        signals.push({
          key: "sales_trend_30d",
          severity: g <= -20 ? "high" : "attention",
          count: Math.round(g * 10) / 10,
          message_ar:
            g < 0
              ? `المبيعات انخفضت ${Math.abs(Math.round(g * 10) / 10)}% مقارنة بـ 30 يوم قبل كده.`
              : `المبيعات زادت ${Math.round(g * 10) / 10}% مقارنة بـ 30 يوم قبل كده.`,
          message_en:
            g < 0
              ? `Sales down ${Math.abs(Math.round(g * 10) / 10)}% vs the previous 30-day window.`
              : `Sales up ${Math.round(g * 10) / 10}% vs the previous 30-day window.`,
          examples: [],
          drillDownTool: "get_sales_comparison",
        });
      }
    }

    // Report inventory value as an 'info' signal even when nothing's wrong —
    // the Agent can decide whether to mention it depending on the user's
    // exact ask.
    signals.push({
      key: "inventory_value",
      severity: "info",
      count: inventorySnapshot.productCount,
      message_ar: `قيمة المخزون الحالية ≈ ${Math.round(inventorySnapshot.totalValue).toLocaleString("en-US")} جنيه على ${inventorySnapshot.productCount} منتج.`,
      message_en: `Current inventory value ≈ EGP ${Math.round(inventorySnapshot.totalValue).toLocaleString("en-US")} across ${inventorySnapshot.productCount} products.`,
      examples: [],
      drillDownTool: "get_inventory_value",
    });

    const severityRank = { high: 0, attention: 1, info: 2 } as const;
    signals.sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] || b.count - a.count,
    );

    return {
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        windowDays,
        currency: "EGP",
        signals,
      } satisfies ShopPulseResult,
    };
  },
};
