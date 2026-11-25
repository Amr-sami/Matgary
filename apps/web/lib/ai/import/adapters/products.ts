import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import {
  addProduct,
  findProductBySku,
  listCategories,
  listProducts,
  updateProduct,
} from "@/lib/repo/catalog";

import type { ParsedSheet } from "../parse";

import type {
  AdapterContext,
  ClassifyResult,
  ImportEntityAdapter,
  ProcessedRow,
  RowError,
  RowIssue,
} from "./types";

/**
 * F10.1 — Product import adapter.
 *
 * Column mapping uses a per-canonical-field alias table with AR/EN/PT/FR/ES
 * forms. Resolution reuses the existing F2 canonicalisation implicitly —
 * `findProductBySku` matches on the same normalised SKU column as the live
 * search path.
 *
 * SAFETY:
 *   • Never invents a product_id, SKU, or price.
 *   • Missing optional fields → `missing` row (surfaced for correction).
 *   • Missing required field (name) → `invalid` row.
 *   • Duplicate SKU inside the file → `invalid`.
 *   • Existing SKU in DB → action=update (not an error).
 */

/* ───────────────────────── canonical field schema ─────────────────────── */

export const PRODUCT_CANONICAL_FIELDS = [
  "sku",
  "name",
  "brand",
  "category",
  "quantity",
  "price",         // sale price
  "costPrice",
  "wholesalePrice",
  "lowStockThreshold",
  "barcode",       // treated as SKU alias when the sheet has no SKU column
  "description",
] as const;

const REQUIRED_FOR_CREATE = ["name", "price", "quantity"] as const;

/**
 * Multilingual aliases. Each row: lowercased-and-normalised column header
 * found in a user's sheet → canonical field. Keep AR + EN + PT + FR + ES
 * minimal variants here; fuzzy matching is a follow-on.
 */
const COLUMN_ALIASES: Record<string, string> = {
  // sku
  sku: "sku",
  "product code": "sku",
  "item code": "sku",
  code: "sku",
  reference: "sku",
  "stock code": "sku",
  barcode: "sku",
  "bar code": "sku",
  باركود: "sku",
  "رقم المنتج": "sku",
  "كود المنتج": "sku",
  "الكود/الباركود": "sku",
  "الكود": "sku",
  "código": "sku",
  "código do produto": "sku",
  "código de produto": "sku",
  "código del producto": "sku",
  "code produit": "sku",
  "référence": "sku",
  "referencia": "sku",

  // name
  name: "name",
  "product name": "name",
  "item name": "name",
  title: "name",
  الاسم: "name",
  "اسم المنتج": "name",
  nome: "name",
  nombre: "name",
  nom: "name",

  // brand
  brand: "brand",
  manufacturer: "brand",
  البراند: "brand",
  الماركة: "brand",
  marca: "brand",
  marque: "brand",

  // category
  category: "category",
  الصنف: "category",
  "الفئة": "category",
  categoria: "category",
  catégorie: "category",
  categoría: "category",

  // quantity
  quantity: "quantity",
  qty: "quantity",
  stock: "quantity",
  inventory: "quantity",
  الكمية: "quantity",
  "الكمية المتاحة": "quantity",
  quantidade: "quantity",
  cantidad: "quantity",
  quantité: "quantity",

  // sale price
  price: "price",
  "sale price": "price",
  "selling price": "price",
  "retail price": "price",
  "سعر البيع": "price",
  "السعر": "price",
  "preço": "price",
  "preço de venda": "price",
  "precio": "price",
  "precio de venta": "price",
  "prix": "price",
  "prix de vente": "price",

  // cost price
  "cost price": "costPrice",
  "purchase price": "costPrice",
  cost: "costPrice",
  costprice: "costPrice",
  "سعر الشراء": "costPrice",
  "سعر التكلفة": "costPrice",
  "preço de custo": "costPrice",
  "precio de costo": "costPrice",
  "prix d'achat": "costPrice",

  // wholesale price
  "wholesale price": "wholesalePrice",
  "dealer price": "wholesalePrice",
  wholesale: "wholesalePrice",
  "سعر الجملة": "wholesalePrice",
  "سعر تاجر": "wholesalePrice",
  "preço de atacado": "wholesalePrice",
  "precio mayorista": "wholesalePrice",
  "prix de gros": "wholesalePrice",

  // low stock
  threshold: "lowStockThreshold",
  "low stock": "lowStockThreshold",
  "lowstock": "lowStockThreshold",
  "حد التنبيه": "lowStockThreshold",
  "limite minimo": "lowStockThreshold",

  // description
  description: "description",
  الوصف: "description",
  descrição: "description",
  descripción: "description",
};

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/* ───────────────────────── classify ──────────────────────────────────── */

function classify(sheet: ParsedSheet): ClassifyResult {
  const fieldMappingHint: Record<string, string> = {};
  const detected = new Set<string>();
  for (const col of sheet.columns) {
    const key = normaliseHeader(col);
    const canonical = COLUMN_ALIASES[key];
    if (canonical) {
      fieldMappingHint[canonical] = col;
      detected.add(canonical);
    }
  }
  // Products are recognised by the presence of either a SKU or a (name + price)
  // combo. A single random matching column isn't enough.
  const hasSku = detected.has("sku");
  const hasName = detected.has("name");
  const hasPrice = detected.has("price");
  let confidence = 0;
  if (hasSku && hasName) confidence = 0.95;
  else if (hasSku || (hasName && hasPrice)) confidence = 0.85;
  else if (hasName || detected.has("brand")) confidence = 0.5;
  return {
    entityType: confidence >= 0.5 ? "product" : null,
    confidence,
    fieldMappingHint,
    detectedFields: Array.from(detected),
  };
}

/* ───────────────────────── map ──────────────────────────────────────── */

function mapRow(
  raw: Record<string, string>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [canonical, header] of Object.entries(mapping)) {
    const v = raw[header];
    if (v == null) continue;
    switch (canonical) {
      case "quantity":
      case "lowStockThreshold":
        out[canonical] = parseIntOrNull(v);
        break;
      case "price":
      case "costPrice":
      case "wholesalePrice":
        out[canonical] = parseNumberOrNull(v);
        break;
      default:
        out[canonical] = v.trim() || null;
    }
  }
  return out;
}

function parseIntOrNull(v: string): number | null {
  const s = v.replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : Number.isFinite(n) ? Math.floor(n) : null;
}

function parseNumberOrNull(v: string): number | null {
  const s = v.replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────────── validate + resolve ─────────────────────────── */

/** Short-lived cache of tenant categories so we don't fire one SELECT per
 *  row inside the validate loop. 30 s is well below the time a human spends
 *  editing a preview, and categories rarely change mid-import. */
interface TenantCategorySnapshot {
  fetchedAt: number;
  categories: Array<{ id: string; key: string; label: string }>;
}
const CATEGORY_SNAPSHOT_TTL_MS = 30_000;
const categorySnapshotCache = new Map<string, TenantCategorySnapshot>();

async function getTenantCategories(
  tenantId: string,
): Promise<TenantCategorySnapshot["categories"]> {
  const now = Date.now();
  const cached = categorySnapshotCache.get(tenantId);
  if (cached && now - cached.fetchedAt < CATEGORY_SNAPSHOT_TTL_MS) {
    return cached.categories;
  }
  const rows = await listCategories(tenantId, null);
  const cats = rows.map((r) => ({ id: r.id, key: r.key, label: r.label }));
  categorySnapshotCache.set(tenantId, { fetchedAt: now, categories: cats });
  return cats;
}

/** Public for tests — clear the module-level cache between runs. */
export function _clearCategorySnapshotCache(): void {
  categorySnapshotCache.clear();
}

interface CategoryResolution {
  /** The resolved category uuid when a match was found, else null. */
  categoryId: string | null;
  /** The matched label (for the preview), else null. */
  categoryLabel: string | null;
  /** When no match is found, the list of allowed labels the user can pick
   *  from in the editable preview. */
  candidates: string[];
  /** Diagnostic reason for the "no match" case. */
  reason: "matched" | "missing" | "unknown" | "no_categories_configured";
}

/** Resolve one row's category against the tenant's catalog. Pure w.r.t.
 *  the passed-in snapshot — no DB calls. */
function resolveCategory(
  requested: string | null,
  categories: TenantCategorySnapshot["categories"],
): CategoryResolution {
  if (categories.length === 0) {
    return { categoryId: null, categoryLabel: null, candidates: [], reason: "no_categories_configured" };
  }
  const candidates = categories.map((c) => c.label);
  if (!requested || !requested.trim()) {
    return { categoryId: null, categoryLabel: null, candidates, reason: "missing" };
  }
  const needle = requested.trim().toLowerCase();
  const match =
    categories.find((c) => c.key.toLowerCase() === needle) ??
    categories.find((c) => c.label.toLowerCase() === needle);
  if (!match) {
    return { categoryId: null, categoryLabel: null, candidates, reason: "unknown" };
  }
  return {
    categoryId: match.id,
    categoryLabel: match.label,
    candidates,
    reason: "matched",
  };
}

async function validateAndResolve(opts: {
  rowIndex: number;
  raw: Record<string, string>;
  normalised: Record<string, unknown>;
  ctx: AdapterContext;
  seenSkus: Set<string>;
}): Promise<ProcessedRow> {
  const errors: RowError[] = [];
  const issues: RowIssue[] = [];
  const n = opts.normalised;

  const name = typeof n.name === "string" ? n.name.trim() : "";
  const sku = typeof n.sku === "string" ? n.sku.trim() : "";
  const quantity = typeof n.quantity === "number" ? n.quantity : null;
  const price = typeof n.price === "number" ? n.price : null;

  // Hard errors first.
  if (!name) errors.push({ field: "name", code: "REQUIRED", message: "Name is required" });
  if (price !== null && price < 0) errors.push({ field: "price", code: "NEGATIVE", message: "Price cannot be negative" });
  if (quantity !== null && quantity < 0) errors.push({ field: "quantity", code: "NEGATIVE", message: "Quantity cannot be negative" });

  // Intra-file duplicate SKU detection.
  if (sku) {
    const normSku = sku.toLowerCase();
    if (opts.seenSkus.has(normSku)) {
      errors.push({
        field: "sku",
        code: "DUPLICATE_IN_FILE",
        message: `SKU "${sku}" appears more than once in this file`,
      });
    } else {
      opts.seenSkus.add(normSku);
    }
  }

  // Missing-but-optional issues (surfaced for conversational correction).
  if (price === null) {
    issues.push({ kind: "missing_field", field: "price", message: "Sale price is missing" });
  }
  if (quantity === null) {
    issues.push({ kind: "missing_field", field: "quantity", message: "Quantity is missing" });
  }

  // Resolution: look up by SKU. If found → update path. Otherwise → create.
  let existing: {
    id: string;
    name: string;
    price: unknown;
    quantity: number;
    categoryId: string;
  } | null = null;
  if (sku) {
    try {
      const matches = await findProductBySku(opts.ctx.tenantId, sku);
      // Storo has no branch feature; use the first match (products are
      // tenant-scoped in the AI path).
      const picked = matches[0] ?? null;
      if (picked) {
        existing = {
          id: picked.product.id,
          name: picked.product.name,
          price: picked.product.price,
          quantity: picked.product.quantity,
          // Public Product.category is a string uuid — the FK the executor
          // would otherwise look up again.
          categoryId: picked.product.category,
        };
      }
    } catch {
      // Lookup failure → leave existing=null; treat as create.
    }
  }

  // Category resolution — single source of truth, no silent fallback.
  // An existing SKU-matched product keeps its category unless the row
  // explicitly asked for a different one. A create row with no resolvable
  // category becomes MISSING so the user picks one in the preview.
  const tenantCategories = await getTenantCategories(opts.ctx.tenantId);
  const requestedCategory = typeof n.category === "string" ? n.category : null;
  const categoryRes = resolveCategory(requestedCategory, tenantCategories);
  let categoryId: string | null = categoryRes.categoryId;
  let categoryLabel: string | null = categoryRes.categoryLabel;
  if (!categoryId && existing) {
    // Update path with no explicit category → reuse the live category of the
    // SKU-matched product. This is deterministic and tenant-local — not an
    // LLM guess.
    const exCat = tenantCategories.find((c) => c.id === existing!.categoryId);
    if (exCat) {
      categoryId = exCat.id;
      categoryLabel = exCat.label;
    }
  }
  if (!categoryId) {
    if (categoryRes.reason === "no_categories_configured") {
      errors.push({
        field: "category",
        code: "NO_CATEGORIES_CONFIGURED",
        message: "This workspace has no categories configured yet",
      });
    } else if (categoryRes.reason === "unknown") {
      issues.push({
        kind: "unknown_category",
        field: "category",
        message: `Unknown category "${requestedCategory}". Pick one of: ${categoryRes.candidates.slice(0, 6).join(", ")}${categoryRes.candidates.length > 6 ? ", …" : ""}`,
        candidates: categoryRes.candidates.map((label) => ({ label })),
      });
    } else {
      issues.push({
        kind: "missing_field",
        field: "category",
        message: "Category is required",
        candidates: categoryRes.candidates.map((label) => ({ label })),
      });
    }
  }

  const resolution: Record<string, unknown> = existing
    ? {
        kind: "existing_by_sku",
        existingId: existing.id,
        existingValues: {
          ...existing,
          category: tenantCategories.find((c) => c.id === existing.categoryId)?.label ?? null,
        },
        categoryId,
        categoryLabel,
      }
    : { kind: "new", categoryId, categoryLabel };

  // Decide status.
  let status: ProcessedRow["status"];
  let action: ProcessedRow["action"] = "none";
  if (errors.length > 0) {
    status = "invalid";
    action = "skip";
  } else if (existing) {
    // Updates always ready — we reuse the existing category when none was
    // explicitly provided, and the SKU lookup is deterministic.
    status = "ready";
    action = "update";
  } else {
    // For create: ensure required fields AND category are present.
    const missing = REQUIRED_FOR_CREATE.filter((f) => n[f] == null || n[f] === "");
    if (missing.length > 0) {
      missing.forEach((f) =>
        issues.push({ kind: "missing_field", field: f, message: `${f} is required to create` }),
      );
      status = "missing";
      action = "none";
    } else if (!categoryId) {
      // Category unresolved on a CREATE row → block execution. The
      // editable preview surfaces this with a cell-level status + the
      // candidate list, so the user can pick without round-tripping the file.
      status = "missing";
      action = "none";
    } else {
      status = "ready";
      action = "create";
    }
  }

  return {
    rowIndex: opts.rowIndex,
    status,
    action,
    raw: opts.raw,
    normalised: n,
    resolution,
    errors,
    issues,
  };
}

/* ───────────────────────── preview ──────────────────────────────────── */

function buildPreview(rows: ProcessedRow[]) {
  const toCreate = rows.filter((r) => r.action === "create" && r.status === "ready");
  const toUpdate = rows.filter((r) => r.action === "update" && r.status === "ready");
  const toSkip = rows.filter((r) => r.status === "skipped" || r.action === "skip");
  const invalid = rows.filter((r) => r.status === "invalid");
  const ambiguous = rows.filter((r) => r.status === "ambiguous");
  const missing = rows.filter((r) => r.status === "missing");
  return {
    totalRows: rows.length,
    toCreate: toCreate.length,
    toUpdate: toUpdate.length,
    toSkip: toSkip.length,
    invalid: invalid.length,
    ambiguous: ambiguous.length,
    missing: missing.length,
    sampleCreate: toCreate.slice(0, 3),
    sampleUpdate: toUpdate.slice(0, 3),
    sampleIssues: [...invalid, ...missing, ...ambiguous].slice(0, 5),
  };
}

/* ───────────────────────── execute ──────────────────────────────────── */

async function executeRow(opts: {
  row: ProcessedRow;
  ctx: AdapterContext;
}): Promise<
  | {
      ok: true;
      action: "create" | "update";
      entityId: string;
      entityLabel: string;
      beforeState: Record<string, unknown>;
      afterState: Record<string, unknown>;
      affectedFields: string[];
    }
  | { ok: false; reason: string }
> {
  const { row, ctx } = opts;
  if (row.action === "update") {
    const resolution = row.resolution as {
      existingId?: string;
      existingValues?: { id: string; name: string; price: unknown; quantity: number };
    };
    const id = resolution.existingId;
    if (!id) return { ok: false, reason: "missing_existing_id" };
    const beforeState: Record<string, unknown> = {
      price: Number(resolution.existingValues?.price ?? 0),
      quantity: resolution.existingValues?.quantity ?? 0,
    };
    const patch: { price?: number; quantity?: number } = {};
    const n = row.normalised;
    const affected: string[] = [];
    if (typeof n.price === "number") {
      patch.price = n.price;
      affected.push("price");
    }
    if (typeof n.quantity === "number") {
      patch.quantity = n.quantity;
      affected.push("quantity");
    }
    if (affected.length === 0) {
      return { ok: false, reason: "no_update_fields" };
    }
    const ok = await updateProduct(ctx.tenantId, id, patch);
    if (!ok) return { ok: false, reason: "update_failed" };
    // Post-verify through listProducts for consistency with F5 executors.
    const all = await listProducts(ctx.tenantId, null);
    const after = all.find((p) => p.id === id);
    if (!after) return { ok: false, reason: "post_verify_missing" };
    const afterState: Record<string, unknown> = {};
    if (patch.price !== undefined) afterState.price = Number(after.price);
    if (patch.quantity !== undefined) afterState.quantity = after.quantity;
    return {
      ok: true,
      action: "update",
      entityId: id,
      entityLabel: after.name,
      beforeState: Object.fromEntries(affected.map((f) => [f, beforeState[f]])),
      afterState,
      affectedFields: affected,
    };
  }
  if (row.action === "create") {
    const n = row.normalised;
    // Category MUST have been resolved at validate time. The old code
    // silently fell back to `categories[0]`, which could mis-categorise every
    // new product in a file that had no Category column. If the validator
    // doesn't hand us a categoryId, refuse the execution — the row should
    // have been flagged `missing` and never reached this branch.
    const resolution = row.resolution as {
      categoryId?: string | null;
      categoryLabel?: string | null;
    };
    const categoryId = typeof resolution.categoryId === "string" ? resolution.categoryId : null;
    if (!categoryId) {
      return { ok: false, reason: "category_unresolved" };
    }
    // Last-line sanity: the category must still exist in the tenant's
    // catalog at execute time (a category could have been deleted between
    // validate and confirm).
    const stillExists = await getTenantCategories(ctx.tenantId);
    if (!stillExists.some((c) => c.id === categoryId)) {
      return { ok: false, reason: "category_no_longer_exists" };
    }
    // `products.branch_id` is NOT NULL at the schema level. Storo has no
    // branch feature at the AI layer; resolve the tenant's one branch row
    // here so the insert satisfies the existing schema without the adapter
    // caller ever supplying a branch id.
    const branchId = await resolveTenantBranchIdForImport(ctx.tenantId);
    if (!branchId) return { ok: false, reason: "no_tenant_branch" };
    try {
      const { id } = await addProduct(ctx.tenantId, branchId, {
        name: String(n.name),
        categoryId,
        brand: typeof n.brand === "string" ? n.brand : undefined,
        quantity: typeof n.quantity === "number" ? n.quantity : 0,
        price: typeof n.price === "number" ? n.price : 0,
        costPrice: typeof n.costPrice === "number" ? n.costPrice : undefined,
        lowStockThreshold: typeof n.lowStockThreshold === "number" ? n.lowStockThreshold : 2,
        sku: typeof n.sku === "string" ? n.sku : undefined,
      });
      const after = (await listProducts(ctx.tenantId, null)).find((p) => p.id === id);
      if (!after) return { ok: false, reason: "post_verify_missing" };
      return {
        ok: true,
        action: "create",
        entityId: id,
        entityLabel: after.name,
        beforeState: { exists: false },
        afterState: {
          // `exists: true` matches what fetchCurrentState returns for a
          // live product.create — the rollback engine uses diffWatchedFields
          // over this single `exists` key to decide concurrency. Additional
          // fields are informational only and not in `affectedFields`.
          exists: true,
          name: after.name,
          sku: after.sku,
          price: Number(after.price),
          quantity: after.quantity,
        },
        affectedFields: ["exists"],
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, reason: "no_action" };
}

/* ───────────────────────── adapter export ────────────────────────────── */

export const productImportAdapter: ImportEntityAdapter = {
  entityType: "product",
  canonicalFields: PRODUCT_CANONICAL_FIELDS,
  requiredForCreate: REQUIRED_FOR_CREATE,
  classify,
  mapRow,
  validateAndResolve,
  buildPreview,
  executeRow,
};

/* ───────────────────────── registry ──────────────────────────────────── */

const ADAPTERS: Record<string, ImportEntityAdapter> = {
  product: productImportAdapter,
};

export function getAdapter(entityType: string): ImportEntityAdapter {
  const a = ADAPTERS[entityType];
  if (!a) throw new Error(`No adapter for entity type "${entityType}"`);
  return a;
}

/** Resolve the tenant's one branch id for schema constraints on
 *  `products.branch_id` (NOT NULL). Mirrors the resolver used by the F5
 *  customer-create executor — Storo has no branch feature at the AI layer. */
async function resolveTenantBranchIdForImport(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const [primary] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true)))
      .limit(1);
    if (primary?.id) return primary.id;
    const [any] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.tenantId, tenantId))
      .limit(1);
    return any?.id ?? null;
  });
}
