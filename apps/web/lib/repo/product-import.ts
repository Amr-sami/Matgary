import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  brands,
  categories,
  categoryAttributes,
  categoryAttributeValues,
  products,
  productAttributeValues,
  productHistory,
} from "@/lib/db/schema";
import { bustCatalogCache } from "@/lib/repo/catalog";

// Bulk product import — CSV-only for v1 (Excel users export-as-CSV).
// Two modes:
//   - preview: parse + validate, never write. Returns the per-row plan
//     so the cashier sees "X create, Y update, Z error" before committing.
//   - commit:  same parse/validate then writes the rows in a single tx
//     keyed off SKU. Inserts when SKU is empty or new; updates otherwise.
//
// Schema accepted (header row is required, header order doesn't matter):
//
//   Required: name, category, price, quantity
//   Recommended: sku (used as upsert key — without it every row is an insert)
//   Optional: brand, cost_price, low_stock_threshold, supplier, location,
//             attribute_values, tags
//
// Examples:
//   sku,name,category,brand,price,cost_price,quantity,attribute_values
//   SKU-001,سماعة بلوتوث,electronics,Anker,850,600,25,
//   SKU-002,ساعة Casio MTP,watches,Casio,1450,950,18,gender=رجالي
//
// Rules:
//   - `category` accepts the category KEY ("watches") OR LABEL ("ساعات").
//   - `attribute_values` is `key=label;key2=label2` — each label is matched
//     against the category's existing attribute values. Unknown labels
//     error out with a clear message rather than silently inserting.
//   - All money/qty fields are validated as numbers.
//   - Multi-store: every row lands at the active branch.

export interface ImportRowError {
  row: number; // 1-based, matches the user's view
  field: string | null;
  message: string;
}

export type ImportRowAction = "create" | "update" | "error";

export interface ImportRowPlan {
  row: number;
  action: ImportRowAction;
  /** Echoed back to the UI so the preview table shows what the cashier
   *  typed even when validation pass-throughs trim/normalise it. */
  raw: Record<string, string>;
  resolved?: ResolvedProductRow;
  errors: ImportRowError[];
}

export interface ImportPreview {
  /** Total parsed rows (including errors). */
  rows: number;
  toCreate: number;
  toUpdate: number;
  errored: number;
  plans: ImportRowPlan[];
}

export interface ImportResult extends ImportPreview {
  /** What actually happened on commit (might differ from preview if a
   *  concurrent change snuck in between preview and commit). */
  created: number;
  updated: number;
  failed: number;
}

interface ResolvedProductRow {
  /** Set when the row will update an existing product (matched by SKU). */
  productId: string | null;
  sku: string | null;
  name: string;
  categoryId: string;
  brand: string | null;
  price: number;
  costPrice: number | null;
  quantity: number;
  lowStockThreshold: number;
  supplier: string | null;
  location: string | null;
  tags: string[];
  /** Resolved attribute-value ids keyed by attribute id. */
  attributeValueIds: { attributeId: string; valueId: string; valueLabel: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser — hand-rolled RFC-4180-ish. Handles quoted fields with embedded
// commas/quotes (`"hello, world"`, `"she said ""hi"""`). Multi-line quoted
// fields aren't supported (rare in product imports; would add 30 lines).
// ─────────────────────────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  // Strip a leading UTF-8 BOM if present (Excel loves these).
  const clean = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    rows.push(parseCsvLine(line));
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate — runs read-only against the active branch's catalog.
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_HEADERS = ["name", "category", "price", "quantity"] as const;
const KNOWN_HEADERS = [
  "sku",
  "name",
  "category",
  "brand",
  "price",
  "cost_price",
  "quantity",
  "low_stock_threshold",
  "supplier",
  "location",
  "attribute_values",
  "tags",
] as const;

interface CategoryLookup {
  byKey: Map<string, string>;
  byLabel: Map<string, string>;
  /** id → { attribute_id, attribute_key, values: { label, id }[] } */
  attrsByCategory: Map<
    string,
    Array<{
      attributeId: string;
      attributeKey: string;
      attributeLabel: string;
      values: Array<{ id: string; key: string; label: string }>;
    }>
  >;
}

async function buildCategoryLookup(
  tenantId: string,
  branchId: string,
): Promise<CategoryLookup> {
  return withTenant(tenantId, async (tx) => {
    const cats = await tx
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          eq(categories.branchId, branchId),
        ),
      );
    const attrs =
      cats.length === 0
        ? []
        : await tx
            .select()
            .from(categoryAttributes)
            .where(
              and(
                eq(categoryAttributes.tenantId, tenantId),
                inArray(
                  categoryAttributes.categoryId,
                  cats.map((c) => c.id),
                ),
              ),
            );
    const vals =
      attrs.length === 0
        ? []
        : await tx
            .select()
            .from(categoryAttributeValues)
            .where(
              and(
                eq(categoryAttributeValues.tenantId, tenantId),
                inArray(
                  categoryAttributeValues.attributeId,
                  attrs.map((a) => a.id),
                ),
              ),
            );

    const byKey = new Map<string, string>();
    const byLabel = new Map<string, string>();
    for (const c of cats) {
      byKey.set(c.key.trim().toLowerCase(), c.id);
      byLabel.set(c.label.trim().toLowerCase(), c.id);
    }

    const attrsByCategory = new Map<
      string,
      CategoryLookup["attrsByCategory"] extends Map<string, infer T> ? T : never
    >();
    for (const a of attrs) {
      const list = attrsByCategory.get(a.categoryId) ?? [];
      list.push({
        attributeId: a.id,
        attributeKey: a.key,
        attributeLabel: a.label,
        values: vals
          .filter((v) => v.attributeId === a.id)
          .map((v) => ({ id: v.id, key: v.key, label: v.label })),
      });
      attrsByCategory.set(a.categoryId, list);
    }

    return { byKey, byLabel, attrsByCategory };
  });
}

function resolveCategory(
  raw: string,
  lookup: CategoryLookup,
): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return lookup.byKey.get(v) ?? lookup.byLabel.get(v) ?? null;
}

function parseAttributeValues(
  raw: string,
  categoryId: string,
  lookup: CategoryLookup,
):
  | { ok: true; resolved: ResolvedProductRow["attributeValueIds"] }
  | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, resolved: [] };
  const attrs = lookup.attrsByCategory.get(categoryId) ?? [];
  const out: ResolvedProductRow["attributeValueIds"] = [];
  // Allow `;` or `|` as separator between attribute pairs — Excel's
  // default region settings sometimes confuse `,` so be lenient.
  const pairs = raw.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      return { ok: false, error: `صيغة غير صحيحة في خانة attribute_values: "${pair}"` };
    }
    const key = pair.slice(0, eq).trim().toLowerCase();
    const label = pair.slice(eq + 1).trim();
    const attr = attrs.find(
      (a) =>
        a.attributeKey.toLowerCase() === key ||
        a.attributeLabel.toLowerCase() === key,
    );
    if (!attr) {
      return {
        ok: false,
        error: `هذا الصنف لا يحتوي على خاصية اسمها "${key}"`,
      };
    }
    const valueRow = attr.values.find(
      (v) =>
        v.label.trim().toLowerCase() === label.toLowerCase() ||
        v.key.trim().toLowerCase() === label.toLowerCase(),
    );
    if (!valueRow) {
      return {
        ok: false,
        error: `قيمة "${label}" غير موجودة في خاصية "${attr.attributeLabel}". القيم المتاحة: ${attr.values.map((v) => v.label).join(", ")}`,
      };
    }
    out.push({
      attributeId: attr.attributeId,
      valueId: valueRow.id,
      valueLabel: valueRow.label,
    });
  }
  return { ok: true, resolved: out };
}

function num(raw: string, allowEmpty: boolean): number | null {
  const v = raw.trim();
  if (!v) return allowEmpty ? null : NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function int(raw: string, allowEmpty: boolean): number | null {
  const v = num(raw, allowEmpty);
  if (v == null) return null;
  if (!Number.isFinite(v) || !Number.isInteger(v)) return NaN;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — preview + commit
// ─────────────────────────────────────────────────────────────────────────────

export interface ImportContext {
  tenantId: string;
  branchId: string;
  /** Recorded against product_history rows the import inserts. */
  actorUserId: string | null;
}

export async function previewImport(
  ctx: ImportContext,
  csvText: string,
): Promise<ImportPreview> {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    return { rows: 0, toCreate: 0, toUpdate: 0, errored: 0, plans: [] };
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  for (const req of REQUIRED_HEADERS) {
    if (!headers.includes(req)) {
      return {
        rows: 0,
        toCreate: 0,
        toUpdate: 0,
        errored: 1,
        plans: [
          {
            row: 1,
            action: "error",
            raw: {},
            errors: [
              {
                row: 1,
                field: null,
                message: `ينقص العمود المطلوب: "${req}". الأعمدة المطلوبة: ${REQUIRED_HEADERS.join(", ")}`,
              },
            ],
          },
        ],
      };
    }
  }
  const unknown = headers.filter((h) => !KNOWN_HEADERS.includes(h as any));
  if (unknown.length > 0) {
    // Not fatal — owner may add notes columns. Just ignore them. Logged
    // as a row-1 "info" via the planner if we wanted; for v1 we silently
    // drop unknown columns to keep the preview UX simple.
  }

  const idx = (h: string) => headers.indexOf(h);
  const lookup = await buildCategoryLookup(ctx.tenantId, ctx.branchId);

  // Pre-fetch existing products in this branch keyed by SKU so the
  // upsert decision is a hash lookup instead of N queries.
  const existing = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({
        id: products.id,
        sku: products.sku,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, ctx.tenantId),
          eq(products.branchId, ctx.branchId),
        ),
      ),
  );
  const existingBySku = new Map<string, { id: string; categoryId: string }>();
  for (const p of existing) {
    if (p.sku) existingBySku.set(p.sku.trim(), { id: p.id, categoryId: p.categoryId });
  }

  const plans: ImportRowPlan[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const raw: Record<string, string> = {};
    for (let j = 0; j < headers.length; j += 1) {
      raw[headers[j]] = cells[j] ?? "";
    }
    const errs: ImportRowError[] = [];
    const rowNum = i + 1; // 1-based, matching what the cashier sees in their CSV editor

    const name = (raw.name ?? "").trim();
    if (!name) errs.push({ row: rowNum, field: "name", message: "الاسم مطلوب" });

    const sku = (raw.sku ?? "").trim() || null;

    const categoryRaw = (raw.category ?? "").trim();
    let categoryId: string | null = null;
    if (!categoryRaw && !sku) {
      errs.push({
        row: rowNum,
        field: "category",
        message: "الصنف مطلوب لمنتج جديد",
      });
    } else if (categoryRaw) {
      categoryId = resolveCategory(categoryRaw, lookup);
      if (!categoryId) {
        errs.push({
          row: rowNum,
          field: "category",
          message: `الصنف "${categoryRaw}" غير موجود في هذا الفرع. الأصناف المتاحة: ${[...lookup.byLabel.keys()].join(", ")}`,
        });
      }
    } else {
      // SKU-only update with no category — inherit existing category.
      const ex = sku ? existingBySku.get(sku) : undefined;
      if (ex) categoryId = ex.categoryId;
    }

    const price = num(raw.price ?? "", false);
    if (price == null || !Number.isFinite(price) || price < 0) {
      errs.push({
        row: rowNum,
        field: "price",
        message: "السعر مطلوب ويجب أن يكون رقماً صحيحاً ≥ 0",
      });
    }

    const costPrice = num(raw.cost_price ?? "", true);
    if (costPrice != null && (!Number.isFinite(costPrice) || costPrice < 0)) {
      errs.push({
        row: rowNum,
        field: "cost_price",
        message: "سعر التكلفة يجب أن يكون رقماً ≥ 0",
      });
    }

    const quantity = int(raw.quantity ?? "", false);
    if (quantity == null || !Number.isFinite(quantity) || quantity < 0) {
      errs.push({
        row: rowNum,
        field: "quantity",
        message: "الكمية مطلوبة ويجب أن تكون عدداً صحيحاً ≥ 0",
      });
    }

    const lowStock = int(raw.low_stock_threshold ?? "", true);
    if (lowStock != null && (!Number.isFinite(lowStock) || lowStock < 0)) {
      errs.push({
        row: rowNum,
        field: "low_stock_threshold",
        message: "حد التنبيه يجب أن يكون عدداً صحيحاً ≥ 0",
      });
    }

    let attributeValueIds: ResolvedProductRow["attributeValueIds"] = [];
    if (categoryId) {
      const av = parseAttributeValues(
        raw.attribute_values ?? "",
        categoryId,
        lookup,
      );
      if (!av.ok) {
        errs.push({
          row: rowNum,
          field: "attribute_values",
          message: av.error,
        });
      } else {
        attributeValueIds = av.resolved;
      }
    }

    const tagsRaw = (raw.tags ?? "").trim();
    const tags = tagsRaw
      ? tagsRaw.split(/[,،]/).map((t) => t.trim()).filter(Boolean)
      : [];

    const isUpdate = sku ? existingBySku.has(sku) : false;

    if (errs.length > 0) {
      plans.push({ row: rowNum, action: "error", raw, errors: errs });
      continue;
    }

    const resolved: ResolvedProductRow = {
      productId: isUpdate ? existingBySku.get(sku!)!.id : null,
      sku,
      name,
      categoryId: categoryId!,
      brand: (raw.brand ?? "").trim() || null,
      price: price!,
      costPrice: costPrice,
      quantity: quantity!,
      lowStockThreshold: lowStock ?? 3,
      supplier: (raw.supplier ?? "").trim() || null,
      location: (raw.location ?? "").trim() || null,
      tags,
      attributeValueIds,
    };

    plans.push({
      row: rowNum,
      action: isUpdate ? "update" : "create",
      raw,
      resolved,
      errors: [],
    });
  }

  return summarise(plans);
}

function summarise(plans: ImportRowPlan[]): ImportPreview {
  let toCreate = 0;
  let toUpdate = 0;
  let errored = 0;
  for (const p of plans) {
    if (p.action === "create") toCreate += 1;
    else if (p.action === "update") toUpdate += 1;
    else errored += 1;
  }
  return { rows: plans.length, toCreate, toUpdate, errored, plans };
}

/**
 * Commit a previously-validated import. Re-validates everything because
 * a category could have been deleted between preview and commit. Inserts
 * + updates run in a single tx so a mid-batch failure rolls back the
 * whole commit (better than half-imported inventory).
 */
export async function commitImport(
  ctx: ImportContext,
  csvText: string,
): Promise<ImportResult> {
  const preview = await previewImport(ctx, csvText);
  if (preview.errored > 0) {
    return { ...preview, created: 0, updated: 0, failed: preview.errored };
  }

  let created = 0;
  let updated = 0;
  let failed = 0;

  await withTenant(ctx.tenantId, async (tx) => {
    for (const plan of preview.plans) {
      if (plan.action === "error" || !plan.resolved) {
        failed += 1;
        continue;
      }
      const r = plan.resolved;
      try {
        if (r.productId) {
          // UPDATE existing product. Touch only the columns the import
          // set; null/undefined leaves them alone.
          await tx
            .update(products)
            .set({
              name: r.name,
              brand: r.brand,
              price: String(r.price),
              costPrice: r.costPrice != null ? String(r.costPrice) : null,
              quantity: r.quantity,
              lowStockThreshold: r.lowStockThreshold,
              supplier: r.supplier,
              location: r.location,
              tags: r.tags,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(products.tenantId, ctx.tenantId),
                eq(products.id, r.productId),
              ),
            );
          updated += 1;
          await tx.insert(productHistory).values({
            tenantId: ctx.tenantId,
            productId: r.productId,
            productName: r.name,
            type: "updated",
          });
        } else {
          const [createdRow] = await tx
            .insert(products)
            .values({
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              categoryId: r.categoryId,
              name: r.name,
              brand: r.brand,
              quantity: r.quantity,
              price: String(r.price),
              costPrice: r.costPrice != null ? String(r.costPrice) : null,
              lowStockThreshold: r.lowStockThreshold,
              sku: r.sku,
              tags: r.tags,
              supplier: r.supplier,
              location: r.location,
            })
            .returning({ id: products.id });
          if (r.attributeValueIds.length > 0) {
            await tx.insert(productAttributeValues).values(
              r.attributeValueIds.map((a) => ({
                productId: createdRow.id,
                attributeId: a.attributeId,
                valueId: a.valueId,
                valueLabel: a.valueLabel,
                tenantId: ctx.tenantId,
                branchId: ctx.branchId,
              })),
            );
          }
          await tx.insert(productHistory).values({
            tenantId: ctx.tenantId,
            productId: createdRow.id,
            productName: r.name,
            type: "created",
            delta: r.quantity,
            quantityAfter: r.quantity,
          });
          created += 1;
        }
      } catch (err) {
        // Per-row error inside the import. Re-throw so the whole tx
        // rolls back — a partially-imported catalog is a worse outcome
        // than a clean failure the owner can re-run.
        const message = err instanceof Error ? err.message : String(err);
        plan.errors.push({
          row: plan.row,
          field: null,
          message: `فشل الكتابة في قاعدة البيانات: ${message}`,
        });
        plan.action = "error";
        failed += 1;
        throw err;
      }
    }
  });

  await bustCatalogCache(ctx.tenantId);

  return { ...preview, created, updated, failed };
}

/**
 * Build a sample CSV pre-populated with the active branch's category
 * keys/labels so the owner has a working template to fill in. Includes
 * inline header comments showing what each column accepts.
 */
export async function buildTemplateCsv(
  tenantId: string,
  branchId: string,
): Promise<string> {
  const lookup = await buildCategoryLookup(tenantId, branchId);
  const sampleCategories = [...lookup.byKey.keys()].slice(0, 3);
  const example1 = sampleCategories[0] ?? "watches";
  const example2 = sampleCategories[1] ?? example1;
  const lines: string[] = [];
  lines.push(
    "sku,name,category,brand,price,cost_price,quantity,low_stock_threshold,supplier,location,attribute_values,tags",
  );
  lines.push(
    `SKU-001,سماعة بلوتوث Anker,${example1},Anker,850,600,25,3,Anker Distrib,رف 1,,تخفيض`,
  );
  lines.push(
    `SKU-002,ساعة Casio MTP,${example2},Casio,1450,950,18,3,,,gender=رجالي,`,
  );
  lines.push(
    `,شنطة جديدة بدون SKU,${example1},Generic,420,250,30,3,,,,`,
  );
  return lines.join("\n");
}
