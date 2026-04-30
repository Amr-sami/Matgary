import type { Category, Gender, Product } from "./types";

export interface ParsedRow {
  ok: boolean;
  errors: string[];
  data?: Omit<Product, "id" | "createdAt" | "updatedAt">;
  raw: Record<string, string>;
}

const HEADER_MAP: Record<string, string> = {
  name: "name",
  الاسم: "name",
  category: "category",
  الصنف: "category",
  gender: "gender",
  الجنس: "gender",
  brand: "brand",
  البراند: "brand",
  الماركة: "brand",
  quantity: "quantity",
  الكمية: "quantity",
  price: "price",
  "سعر البيع": "price",
  السعر: "price",
  costprice: "costPrice",
  "cost price": "costPrice",
  "سعر الشراء": "costPrice",
  lowstock: "lowStockThreshold",
  "low stock": "lowStockThreshold",
  threshold: "lowStockThreshold",
  "حد التنبيه": "lowStockThreshold",
  sku: "sku",
  باركود: "sku",
  "الكود/الباركود": "sku",
  tags: "tags",
  التاجات: "tags",
  supplier: "supplier",
  المورد: "supplier",
  location: "location",
  "مكان التخزين": "location",
};

const CATEGORY_FROM_AR: Record<string, Category> = {
  ساعات: "watches",
  watches: "watches",
  برفانات: "perfumes",
  perfumes: "perfumes",
  نظارات: "sunglasses",
  sunglasses: "sunglasses",
};

const GENDER_FROM_AR: Record<string, Gender> = {
  رجالي: "male",
  male: "male",
  حريمي: "female",
  female: "female",
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCsv(text: string): ParsedRow[] {
  // Strip BOM
  const clean = text.replace(/^﻿/, "").trim();
  if (!clean) return [];
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const rawHeaders = splitCsvLine(lines[0]).map((h) => h.trim());
  const fields = rawHeaders.map((h) => HEADER_MAP[h.toLowerCase()] || HEADER_MAP[h] || "");

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const raw: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => {
      raw[h] = (cells[idx] ?? "").trim();
    });
    const errors: string[] = [];
    const obj: Record<string, unknown> = {};

    fields.forEach((field, idx) => {
      if (!field) return;
      const v = (cells[idx] ?? "").trim();
      if (!v) return;
      switch (field) {
        case "category": {
          const c = CATEGORY_FROM_AR[v.toLowerCase()] || CATEGORY_FROM_AR[v];
          if (!c) errors.push(`صنف غير معروف: ${v}`);
          else obj.category = c;
          break;
        }
        case "gender": {
          const g = GENDER_FROM_AR[v.toLowerCase()] || GENDER_FROM_AR[v];
          if (!g) errors.push(`جنس غير معروف: ${v}`);
          else obj.gender = g;
          break;
        }
        case "tags":
          obj.tags = v
            .split(/[|,]/)
            .map((t) => t.trim())
            .filter(Boolean);
          break;
        case "quantity":
        case "price":
        case "costPrice":
        case "lowStockThreshold": {
          const n = Number(v);
          if (Number.isNaN(n)) errors.push(`قيمة رقمية غير صحيحة لـ ${field}: ${v}`);
          else obj[field] = n;
          break;
        }
        default:
          obj[field] = v;
      }
    });

    if (!obj.name) errors.push("الاسم مطلوب");
    if (!obj.category) errors.push("الصنف مطلوب");
    if (!obj.gender) errors.push("الجنس مطلوب");
    if (typeof obj.quantity !== "number") obj.quantity = 0;
    if (typeof obj.price !== "number") errors.push("سعر البيع مطلوب");
    if (typeof obj.lowStockThreshold !== "number") obj.lowStockThreshold = 3;

    rows.push({
      ok: errors.length === 0,
      errors,
      data: errors.length === 0
        ? (obj as Omit<Product, "id" | "createdAt" | "updatedAt">)
        : undefined,
      raw,
    });
  }
  return rows;
}
