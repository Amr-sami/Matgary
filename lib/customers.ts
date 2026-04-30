import type { Sale, Category } from "./types";
import { CATEGORY_LABELS } from "./types";

/**
 * Generic shape consumed by buildCustomerAggregatesGeneric — accepts
 * either a full Sale (from useSales) or a CustomerSaleRecord
 * (from useCustomersData).
 */
export interface CustomerAggregateInput {
  id: string;
  invoiceId?: string;
  category: string;
  quantitySold?: number;
  totalPrice: number;
  saleDate: Date;
  isReturned: boolean;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: string;
  isPaid?: boolean;
}

export interface CustomerAggregate {
  key: string; // phone preferred, else lowercase name
  name: string;
  phone?: string;
  invoiceCount: number;
  saleCount: number;
  lifetimeValue: number;
  outstandingBalance: number;
  lastVisit: Date;
  firstVisit: Date;
  topCategory?: Category;
  topCategoryCount: number;
  invoiceIds: Set<string>;
}

export function buildCustomerAggregatesGeneric(
  sales: CustomerAggregateInput[]
): CustomerAggregate[] {
  const map = new Map<string, CustomerAggregate>();
  for (const s of sales) {
    if (s.isReturned) continue;
    const name = (s.customerName || "").trim();
    const phone = (s.customerPhone || "").trim();
    if (!name && !phone) continue;
    const key = phone || `name:${name.toLowerCase()}`;

    const cur =
      map.get(key) ||
      ({
        key,
        name: name || "بدون اسم",
        phone: phone || undefined,
        invoiceCount: 0,
        saleCount: 0,
        lifetimeValue: 0,
        outstandingBalance: 0,
        lastVisit: s.saleDate,
        firstVisit: s.saleDate,
        topCategoryCount: 0,
        invoiceIds: new Set<string>(),
      } as CustomerAggregate);

    if (name && cur.name === "بدون اسم") cur.name = name;
    if (!cur.phone && phone) cur.phone = phone;

    cur.saleCount += 1;
    cur.lifetimeValue += s.totalPrice;
    if (s.invoiceId) cur.invoiceIds.add(s.invoiceId);
    if (s.paymentMethod === "deferred" && !s.isPaid) {
      cur.outstandingBalance += s.totalPrice;
    }
    if (s.saleDate > cur.lastVisit) cur.lastVisit = s.saleDate;
    if (s.saleDate < cur.firstVisit) cur.firstVisit = s.saleDate;

    map.set(key, cur);
  }

  // Top-category second pass
  const catCounts = new Map<string, Map<string, number>>();
  for (const s of sales) {
    if (s.isReturned) continue;
    const name = (s.customerName || "").trim();
    const phone = (s.customerPhone || "").trim();
    if (!name && !phone) continue;
    const key = phone || `name:${name.toLowerCase()}`;
    const inner = catCounts.get(key) || new Map<string, number>();
    inner.set(s.category, (inner.get(s.category) || 0) + (s.quantitySold || 1));
    catCounts.set(key, inner);
  }
  for (const [key, agg] of map) {
    const inner = catCounts.get(key);
    agg.invoiceCount = agg.invoiceIds.size || agg.saleCount;
    if (!inner) continue;
    let bestCat: string | undefined;
    let bestCount = 0;
    for (const [cat, count] of inner) {
      if (count > bestCount) {
        bestCount = count;
        bestCat = cat;
      }
    }
    agg.topCategory = bestCat as Category | undefined;
    agg.topCategoryCount = bestCount;
  }

  return Array.from(map.values());
}

export function buildCustomerAggregates(sales: Sale[]): CustomerAggregate[] {
  const map = new Map<string, CustomerAggregate>();
  for (const s of sales) {
    if (s.isReturned) continue;
    const name = (s.customerName || "").trim();
    const phone = (s.customerPhone || "").trim();
    if (!name && !phone) continue;
    const key = phone || `name:${name.toLowerCase()}`;

    const cur =
      map.get(key) ||
      ({
        key,
        name: name || "بدون اسم",
        phone: phone || undefined,
        invoiceCount: 0,
        saleCount: 0,
        lifetimeValue: 0,
        outstandingBalance: 0,
        lastVisit: s.saleDate,
        firstVisit: s.saleDate,
        topCategoryCount: 0,
        invoiceIds: new Set<string>(),
      } as CustomerAggregate);

    if (name && cur.name === "بدون اسم") cur.name = name;
    if (!cur.phone && phone) cur.phone = phone;

    cur.saleCount += 1;
    cur.lifetimeValue += s.totalPrice;
    if (s.invoiceId) cur.invoiceIds.add(s.invoiceId);
    if (s.paymentMethod === "deferred" && !s.isPaid) {
      cur.outstandingBalance += s.totalPrice;
    }
    if (s.saleDate > cur.lastVisit) cur.lastVisit = s.saleDate;
    if (s.saleDate < cur.firstVisit) cur.firstVisit = s.saleDate;

    map.set(key, cur);
  }

  // Compute top category per customer in a second pass (cheap)
  const catCounts = new Map<string, Map<Category, number>>();
  for (const s of sales) {
    if (s.isReturned) continue;
    const name = (s.customerName || "").trim();
    const phone = (s.customerPhone || "").trim();
    if (!name && !phone) continue;
    const key = phone || `name:${name.toLowerCase()}`;
    const inner = catCounts.get(key) || new Map<Category, number>();
    inner.set(s.category, (inner.get(s.category) || 0) + s.quantitySold);
    catCounts.set(key, inner);
  }
  for (const [key, agg] of map) {
    const inner = catCounts.get(key);
    if (!inner) continue;
    let bestCat: Category | undefined;
    let bestCount = 0;
    for (const [cat, count] of inner) {
      if (count > bestCount) {
        bestCount = count;
        bestCat = cat;
      }
    }
    agg.topCategory = bestCat;
    agg.topCategoryCount = bestCount;
    agg.invoiceCount = agg.invoiceIds.size || agg.saleCount;
  }

  return Array.from(map.values());
}

export function topCategoryLabel(cat?: Category): string {
  return cat ? CATEGORY_LABELS[cat] : "—";
}

export function customersToCsv(customers: CustomerAggregate[]): string {
  const headers = [
    "الاسم",
    "الموبايل",
    "عدد الفواتير",
    "عدد القطع",
    "إجمالي الإنفاق",
    "آجل غير مدفوع",
    "أول زيارة",
    "آخر زيارة",
    "الصنف الأكثر شراءً",
  ];
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = customers.map((c) =>
    [
      c.name,
      c.phone || "",
      c.invoiceCount,
      c.saleCount,
      c.lifetimeValue,
      c.outstandingBalance,
      c.firstVisit.toISOString(),
      c.lastVisit.toISOString(),
      topCategoryLabel(c.topCategory),
    ]
      .map(escape)
      .join(",")
  );
  return "﻿" + [headers.join(","), ...rows].join("\n");
}

export function daysSince(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}
