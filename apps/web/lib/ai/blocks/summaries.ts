import { listProducts } from "@/lib/repo/catalog";
import { loadInsightsOverview } from "@/lib/repo/insights";

import { tr } from "../i18n";
import type { Locale } from "../language";
import type {
  ComparisonBlock,
  InventorySummaryBlock,
  SalesSummaryBlock,
  WarningBlock,
} from "../responses";
import { type Period, parsePeriod, windowFor } from "../tools/_shared";

/**
 * F4 — Deterministic server-side block builders.
 * F7 — Multilingual via the shared lib/ai/i18n dictionary.
 *
 * The LLM is allowed to request these blocks and choose non-arithmetic
 * knobs (period, scope, which products to compare). Every number comes from
 * the same repo helpers the mobile insights screens use. The LLM never does
 * arithmetic on business metrics.
 *
 * Each builder returns EITHER a concrete block or a WarningBlock with a
 * stable `code` so partial / unavailable data is surfaced honestly instead
 * of being estimated.
 */

export interface BuildContext {
  tenantId: string;
  branchId: string | null;
  locale: Locale;
}

/* ─────────────────────────── inventory summary ────────────────────────── */

export interface BuildInventorySummaryInput extends BuildContext {
  highlightLimit?: number;
}

export async function buildInventorySummary(
  input: BuildInventorySummaryInput,
): Promise<InventorySummaryBlock | WarningBlock> {
  const limit = input.highlightLimit ?? 3;
  const products = await listProducts(input.tenantId, input.branchId);
  if (products.length === 0) {
    return {
      kind: "warning",
      severity: "info",
      title: tr("inventorySummary.empty.title", input.locale),
      message: tr("inventorySummary.empty.message", input.locale),
      code: "INVENTORY_EMPTY",
    };
  }

  let outOfStock = 0;
  let lowStock = 0;
  let stockValueRetail = 0;
  const lowOrOut: Array<{
    productId: string;
    name: string;
    quantity: number;
    state: "low_stock" | "out_of_stock";
  }> = [];

  for (const p of products) {
    stockValueRetail += Number(p.price) * p.quantity;
    if (p.quantity === 0) {
      outOfStock++;
      lowOrOut.push({ productId: p.id, name: p.name, quantity: 0, state: "out_of_stock" });
    } else if (p.quantity <= p.lowStockThreshold) {
      lowStock++;
      lowOrOut.push({
        productId: p.id,
        name: p.name,
        quantity: p.quantity,
        state: "low_stock",
      });
    }
  }

  lowOrOut.sort((a, b) => {
    if (a.state !== b.state) return a.state === "out_of_stock" ? -1 : 1;
    return a.quantity - b.quantity;
  });

  return {
    kind: "inventory_summary",
    title: tr("inventorySummary.title", input.locale),
    scope: scopeLabel(input),
    totalProducts: products.length,
    lowStockCount: lowStock,
    outOfStockCount: outOfStock,
    stockValue: round2(stockValueRetail),
    stockValueBasis: "retail",
    currency: "EGP",
    highlights: lowOrOut.slice(0, limit),
  };
}

/* ─────────────────────────── sales summary ───────────────────────────── */

export interface BuildSalesSummaryInput extends BuildContext {
  period: Period;
}

export async function buildSalesSummary(
  input: BuildSalesSummaryInput,
): Promise<SalesSummaryBlock | WarningBlock> {
  const period = parsePeriod(input.period);
  const w = windowFor(period);
  const overview = await loadInsightsOverview(input.tenantId, w, input.branchId);
  const metrics = overview.metrics;
  const periodLbl = periodLabel(period, input.locale);

  if (metrics.totalSales === 0) {
    return {
      kind: "warning",
      severity: "info",
      title: tr("salesSummary.empty.title", input.locale),
      message: tr("salesSummary.empty.message", input.locale, { period: periodLbl }),
      code: "SALES_EMPTY",
    };
  }

  const revenue = Number(metrics.totalRevenue);
  const orders = Number(metrics.totalSales);
  const aov = orders > 0 ? revenue / orders : 0;

  const prior = Number(metrics.lastRevenue);
  const revenueTrendPct = prior > 0 ? (revenue - prior) / prior : null;

  const top =
    overview.topProducts && overview.topProducts.length > 0 ? overview.topProducts[0]! : null;

  return {
    kind: "sales_summary",
    title: tr("salesSummary.title", input.locale),
    periodLabel: periodLbl,
    scope: scopeLabel(input),
    revenue: round2(revenue),
    orders,
    averageOrderValue: round2(aov),
    currency: "EGP",
    revenueTrendPct,
    ordersTrendPct: null,
    topLine: top
      ? {
          label: tr("salesSummary.topProduct.label", input.locale, { name: top.name }),
          value: `${top.qty} × ${fmtMoney(Number(top.revenue))} EGP`,
        }
      : undefined,
  };
}

/* ─────────────────────────── product comparison ──────────────────────── */

export interface ComparisonProductInput {
  id: string;
  name: string;
  brand?: string | null;
  sku?: string | null;
  price: number;
  quantity: number;
  lowStockThreshold: number;
}

export function buildProductComparison(
  products: ComparisonProductInput[],
  locale: Locale,
  title?: string,
): ComparisonBlock | WarningBlock {
  if (products.length < 2) {
    return {
      kind: "warning",
      severity: "warning",
      title: tr("comparison.fewProducts.title", locale),
      message: tr("comparison.fewProducts.message", locale),
      code: "COMPARISON_TOO_FEW",
    };
  }
  const seen = new Set<string>();
  const unique = products.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  if (unique.length < 2) {
    return {
      kind: "warning",
      severity: "warning",
      title: tr("comparison.fewProducts.title", locale),
      message: tr("comparison.duplicate.message", locale),
      code: "COMPARISON_DUPLICATE",
    };
  }
  const items = unique.slice(0, 4);

  const cheapest = items.reduce((best, p) => (p.price < best.price ? p : best));
  const mostStocked = items.reduce((best, p) =>
    p.quantity > best.quantity ? p : best,
  );

  const priceLabel = tr("comparison.price.label", locale);
  const stockLabel = tr("comparison.stock.label", locale);
  const brandLabel = tr("comparison.brand.label", locale);
  const skuLabel = tr("comparison.sku.label", locale);

  const values: Record<string, Record<string, string | number | null>> = {
    [priceLabel]: {},
    [stockLabel]: {},
    [brandLabel]: {},
    [skuLabel]: {},
  };
  for (const p of items) {
    values[priceLabel]![p.id] = round2(Number(p.price));
    values[stockLabel]![p.id] = p.quantity;
    values[brandLabel]![p.id] = p.brand ?? null;
    values[skuLabel]![p.id] = p.sku ?? null;
  }

  return {
    kind: "comparison",
    title: title ?? tr("comparison.title", locale),
    entityType: "product",
    entities: items.map((p) => ({
      entityId: p.id,
      label: p.name,
      subtitle: p.brand ?? undefined,
    })),
    attributes: [
      { label: priceLabel, format: "money", winnerEntityId: cheapest.id },
      { label: stockLabel, format: "number", winnerEntityId: mostStocked.id },
      { label: brandLabel, format: "text" },
      { label: skuLabel, format: "text" },
    ],
    values,
    currency: "EGP",
  };
}

/* ─────────────────────────── helpers ──────────────────────────────────── */

function scopeLabel(input: BuildContext): string | undefined {
  if (!input.branchId) return tr("scope.allBranches", input.locale);
  // Caller may override with a pretty branch name; undefined is harmless.
  return undefined;
}

function periodLabel(period: Period, locale: Locale): string {
  return tr(`period.${period}`, locale);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
