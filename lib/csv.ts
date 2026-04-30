import type { Product } from "./types";
import { CATEGORY_LABELS, GENDER_LABELS } from "./types";

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function productsToCsv(products: Product[]): string {
  const headers = [
    "الاسم",
    "الصنف",
    "الجنس",
    "البراند",
    "الكمية",
    "سعر البيع",
    "سعر الشراء",
    "الربح للقطعة",
    "هامش الربح %",
    "حد التنبيه",
    "الكود/الباركود",
    "التاجات",
    "المورد",
    "مكان التخزين",
    "تاريخ الإضافة",
    "آخر تحديث",
  ];
  const rows = products.map((p) => {
    const cost = p.costPrice || 0;
    const profit = p.price - cost;
    const margin = p.price > 0 ? (profit / p.price) * 100 : 0;
    return [
      p.name,
      CATEGORY_LABELS[p.category],
      GENDER_LABELS[p.gender],
      p.brand || "",
      p.quantity,
      p.price,
      cost,
      profit,
      margin.toFixed(1),
      p.lowStockThreshold,
      p.sku || "",
      (p.tags || []).join("|"),
      p.supplier || "",
      p.location || "",
      p.createdAt.toISOString(),
      p.updatedAt.toISOString(),
    ].map(escapeCsv).join(",");
  });
  return "﻿" + [headers.join(","), ...rows].join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
