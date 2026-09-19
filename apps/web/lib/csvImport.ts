import type { CategoryDescriptor, CategoryAttribute } from "./types";

export interface CsvImportContext {
  categories: CategoryDescriptor[];
  /** Map of categoryId -> its attributes (with values). */
  attributesByCategoryId: Record<string, CategoryAttribute[]>;
}

export interface ParsedProductInput {
  name: string;
  categoryId: string;
  brand?: string;
  quantity: number;
  price: number;
  costPrice?: number;
  lowStockThreshold?: number;
  sku?: string;
  tags?: string[];
  supplier?: string;
  location?: string;
  attributeValueIds?: string[];
}

export interface ParsedRow {
  ok: boolean;
  errors: string[];
  data?: ParsedProductInput;
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

/** Match a category cell against the tenant's catalog by key or label, case-insensitive. */
function matchCategory(
  cell: string,
  categories: CategoryDescriptor[],
): CategoryDescriptor | null {
  const norm = cell.trim().toLowerCase();
  if (!norm) return null;
  for (const c of categories) {
    if (c.key.toLowerCase() === norm) return c;
    if (c.label.toLowerCase() === cell.trim().toLowerCase()) return c;
  }
  return null;
}

/** Match an attribute value cell against an attribute's value list. */
function matchAttributeValue(
  cell: string,
  attribute: CategoryAttribute,
): string | null {
  const norm = cell.trim().toLowerCase();
  if (!norm) return null;
  for (const v of attribute.values) {
    if (v.key.toLowerCase() === norm) return v.id;
    if (v.label.toLowerCase() === cell.trim().toLowerCase()) return v.id;
  }
  return null;
}

export function parseCsv(text: string, ctx: CsvImportContext): ParsedRow[] {
  const clean = text.replace(/^﻿/, "").trim();
  if (!clean) return [];
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const rawHeaders = splitCsvLine(lines[0]).map((h) => h.trim());
  const fields = rawHeaders.map(
    (h) => HEADER_MAP[h.toLowerCase()] || HEADER_MAP[h] || "",
  );

  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const raw: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => {
      raw[h] = (cells[idx] ?? "").trim();
    });
    const errors: string[] = [];
    const partial: Partial<ParsedProductInput> = {};
    let resolvedCategory: CategoryDescriptor | null = null;
    let genderCell: string | null = null;

    fields.forEach((field, idx) => {
      if (!field) return;
      const v = (cells[idx] ?? "").trim();
      if (!v) return;
      switch (field) {
        case "category": {
          const c = matchCategory(v, ctx.categories);
          if (!c) errors.push(`صنف غير معروف: ${v}`);
          else {
            resolvedCategory = c;
            partial.categoryId = c.id;
          }
          break;
        }
        case "gender": {
          // Defer until category is resolved so we can map against the right attribute.
          genderCell = v;
          break;
        }
        case "tags":
          partial.tags = v
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
          else (partial as Record<string, number>)[field] = n;
          break;
        }
        default:
          (partial as Record<string, string>)[field] = v;
      }
    });

    // Resolve gender against the chosen category's gender attribute (if any).
    if (resolvedCategory && genderCell) {
      const cat = resolvedCategory as CategoryDescriptor;
      const attrs = ctx.attributesByCategoryId[cat.id] ?? [];
      const genderAttr = attrs.find((a) => a.key === "gender");
      if (!genderAttr) {
        errors.push(`القسم "${cat.label}" لا يحتوي على خاصية الجنس`);
      } else {
        const valueId = matchAttributeValue(genderCell, genderAttr);
        if (!valueId) errors.push(`جنس غير معروف لهذا القسم: ${genderCell}`);
        else partial.attributeValueIds = [...(partial.attributeValueIds ?? []), valueId];
      }
    }

    if (!partial.name) errors.push("الاسم مطلوب");
    if (!partial.categoryId) errors.push("الصنف مطلوب");
    if (typeof partial.quantity !== "number") partial.quantity = 0;
    if (typeof partial.price !== "number") errors.push("سعر البيع مطلوب");
    if (typeof partial.lowStockThreshold !== "number") partial.lowStockThreshold = 3;

    rows.push({
      ok: errors.length === 0,
      errors,
      data: errors.length === 0 ? (partial as ParsedProductInput) : undefined,
      raw,
    });
  }

  return rows;
}
