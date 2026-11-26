import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { listBrands, listCategories, listProducts } from "@/lib/repo/catalog";

import { tr } from "../i18n";
import { resolveBrands } from "../resolve/brand";
import { resolveCategories } from "../resolve/category";
import { resolveProducts } from "../resolve/products";
import type { AiBlock, Locale } from "../responses";
import { createPending } from "../write/pending";

import type { Tool } from "./types";

/**
 * Wave 1 — AI write tools for catalog authoring.
 *
 * Fills the gap identified in the Wave-0 audit: the agent could change
 * price/quantity/threshold but could NOT create products, brands, or
 * categories — so it would (wrongly) refuse with "go to the Products
 * page". These tools make the AI a natural-language control layer for the
 * existing ERP catalog services.
 *
 * Contract:
 *   • Each preview tool is pure w.r.t. the DB: it RESOLVES entities, stages
 *     a server-side pending action (createPending — F5 HMAC), and returns a
 *     confirmation block. It does NOT mutate.
 *   • Execution happens in /api/ai/confirm via executeAction, which calls
 *     the existing addProduct / updateProduct / addBrand / addCategory
 *     services in catalog(-admin).ts — no duplicated business logic.
 *   • Required permission: manage_inventory (same as the equivalent REST
 *     routes). Re-checked at confirm time.
 *   • Owner role bypasses permission checks everywhere.
 *   • The LLM never supplies tenantId / userId / branchId — those come
 *     from the server AgentContext.
 */

/* ────────────────────────── preview_create_product ──────────────── */

export const previewCreateProduct: Tool = {
  name: "preview_create_product",
  description:
    "PREVIEW the creation of a NEW product. Call this when the user says things like 'add a product', 'ضيف منتج', 'عايز أضيف Diamond Sakura تبع Assaf وده برفانات'. Required: name + category (either an existing category_id or a category name/label to resolve). Optional: brand (free-text, auto-created on the product row even if the brand isn't in the brands master list), price, quantity, cost_price, low_stock_threshold, sku. If REQUIRED fields (name, category, price, quantity) are missing, the tool returns a text block listing what's still needed — DO NOT invent values; relay the ask to the user. Returns a confirmation block the user taps to execute.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name, verbatim as the user said it." },
      brand: { type: "string", description: "Brand name as a free-text tag (optional)." },
      category: {
        type: "string",
        description:
          "Category name or key the user mentioned (e.g. 'perfumes', 'برفانات'). Server resolves to a tenant category.",
      },
      category_id: { type: "string", description: "uuid when a category was already resolved earlier in the conversation." },
      sku: { type: "string" },
      price: { type: "number", description: "Sale price in EGP." },
      cost_price: { type: "number", description: "Unit cost in EGP." },
      quantity: { type: "integer", description: "Opening stock quantity." },
      low_stock_threshold: { type: "integer", description: "Low-stock alert threshold. Defaults to 3 when omitted." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const locale = (ctx.locale ?? "en") as Locale;
    const name = str(args.name);
    if (!name) {
      return askForFields(locale, ["name"]);
    }

    const categoryArg = str(args.category);
    const categoryIdArg = str(args.category_id);
    const brand = str(args.brand) || null;
    const sku = str(args.sku) || null;
    const price = num(args.price);
    const costPrice = num(args.cost_price);
    const quantity = int(args.quantity);
    const lowStockThreshold = int(args.low_stock_threshold) ?? 3;

    // Resolve category deterministically. Never fall back to "first category" —
    // the AI must mirror the import adapter's strict rule.
    let categoryId: string | null = null;
    let categoryLabel: string | null = null;
    if (categoryIdArg) {
      const cats = await listCategories(ctx.tenantId, null);
      const direct = cats.find((c) => c.id === categoryIdArg);
      if (direct) {
        categoryId = direct.id;
        categoryLabel = direct.label;
      }
    }
    if (!categoryId && categoryArg) {
      const r = await resolveCategories(ctx.tenantId, categoryArg, { limit: 5 });
      const top = r.candidates[0];
      if (top && top.tier === "HIGH") {
        categoryId = top.id;
        categoryLabel = top.label;
      } else if (r.candidates.length === 0) {
        return offerCreateCategory(locale, categoryArg);
      } else {
        return clarifyCategoryAmbiguous(locale, categoryArg, r.candidates);
      }
    }
    if (!categoryId) {
      return askForFields(locale, ["category"]);
    }

    // Required-for-create fields: name, category, price, quantity.
    const missing: string[] = [];
    if (price === null) missing.push("price");
    if (quantity === null) missing.push("quantity");
    if (missing.length > 0) {
      return askForFields(locale, missing);
    }

    // Validate numerics BEFORE staging. Note: `missing.length > 0` above
    // already short-circuits when price or quantity is null; the narrowing
    // isn't visible to TS so we re-assert here.
    if (price === null || quantity === null) {
      return askForFields(locale, ["price", "quantity"]);
    }
    if (price < 0) return { ok: false, error: "INVALID_PRICE" };
    if (quantity < 0) return { ok: false, error: "INVALID_QUANTITY" };
    if (costPrice !== null && costPrice < 0) return { ok: false, error: "INVALID_COST" };

    // branchId is NOT NULL on products — resolve the tenant's primary branch.
    const branchId = await resolveTenantPrimaryBranch(ctx.tenantId);
    if (!branchId) return { ok: false, error: "NO_TENANT_BRANCH" };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_product",
      params: {
        name,
        categoryId,
        branchId,
        brand,
        sku,
        price,
        costPrice,
        quantity,
        lowStockThreshold,
      },
      preview: {
        locale,
        name,
        brand,
        categoryLabel,
        price,
        quantity,
        costPrice,
      },
    });

    const summary = buildCreateProductSummary(locale, {
      name,
      brand,
      categoryLabel,
      price,
      quantity,
      costPrice,
      lowStockThreshold,
    });

    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.productCreate.title", locale, { name }),
      summary,
      actionLabel: tr("write.productCreate.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ────────────────────────── preview_update_product ──────────────── */

export const previewUpdateProduct: Tool = {
  name: "preview_update_product",
  description:
    "PREVIEW an update to an EXISTING product's attributes other than price/quantity (those have dedicated preview_update_product_price / preview_update_product_quantity tools). Supports name, brand, category (name or id), sku, cost_price, low_stock_threshold. Resolve the target first via product_id OR query (free-text). Returns a confirmation block.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      query: { type: "string", description: "Fallback — resolve by name/sku/brand when product_id is unavailable." },
      name: { type: "string" },
      brand: { type: "string" },
      category: { type: "string", description: "Category name or key." },
      category_id: { type: "string" },
      sku: { type: "string" },
      cost_price: { type: "number" },
      low_stock_threshold: { type: "integer" },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const locale = (ctx.locale ?? "en") as Locale;

    // Resolve target product. Reusing the existing product-resolver pattern:
    // product_id first, query fallback, ambiguity surfaces a clarification.
    const productId = str(args.product_id);
    const query = str(args.query);
    let target: { id: string; name: string } | null = null;
    if (productId) {
      const all = await listProducts(ctx.tenantId, null);
      const found = all.find((p) => p.id === productId);
      if (found) target = { id: found.id, name: found.name };
    }
    if (!target && query) {
      const r = await resolveProducts(
        { tenantId: ctx.tenantId, branchId: null, query },
        { limit: 5 },
      );
      if (r.candidates.length === 0) {
        return {
          ok: true,
          blocks: [{ kind: "text", text: tr("resolve.noMatch", locale, { query }) }],
        };
      }
      const topScore = r.candidates[0]!.score;
      const confident = r.candidates.filter((c) => c.score === topScore);
      if (confident.length === 1 && topScore >= 0.95) {
        target = { id: confident[0]!.id, name: confident[0]!.name };
      } else {
        const list = r.candidates
          .slice(0, 5)
          .map((c) => `• ${c.name}${c.brand ? ` (${c.brand})` : ""}`)
          .join("\n");
        return {
          ok: true,
          blocks: [
            {
              kind: "text",
              text: `${tr("resolve.ambiguousHeader", locale)}\n${list}`,
            },
          ],
        };
      }
    }
    if (!target) {
      return {
        ok: true,
        blocks: [{ kind: "text", text: tr("write.productUpdate.needTarget", locale) }],
      };
    }

    // Resolve category reference if the user specified one.
    let categoryId: string | null = null;
    let categoryLabel: string | null = null;
    const categoryArg = str(args.category);
    const categoryIdArg = str(args.category_id);
    if (categoryIdArg) {
      const cats = await listCategories(ctx.tenantId, null);
      const direct = cats.find((c) => c.id === categoryIdArg);
      if (direct) {
        categoryId = direct.id;
        categoryLabel = direct.label;
      }
    }
    if (!categoryId && categoryArg) {
      const r = await resolveCategories(ctx.tenantId, categoryArg, { limit: 5 });
      const top = r.candidates[0];
      if (top && top.tier === "HIGH") {
        categoryId = top.id;
        categoryLabel = top.label;
      } else if (r.candidates.length === 0) {
        return offerCreateCategory(locale, categoryArg);
      } else {
        return clarifyCategoryAmbiguous(locale, categoryArg, r.candidates);
      }
    }

    // Assemble patch. Only include the fields the caller actually passed.
    const patch: Record<string, unknown> = {};
    if (str(args.name)) patch.name = str(args.name);
    if (args.brand !== undefined) patch.brand = str(args.brand) || null;
    if (args.sku !== undefined) patch.sku = str(args.sku) || null;
    if (categoryId) patch.categoryId = categoryId;
    const costArg = num(args.cost_price);
    if (costArg !== null) {
      if (costArg < 0) return { ok: false, error: "INVALID_COST" };
      patch.costPrice = costArg;
    }
    const thresholdArg = int(args.low_stock_threshold);
    if (thresholdArg !== null) {
      if (thresholdArg < 0) return { ok: false, error: "INVALID_THRESHOLD" };
      patch.lowStockThreshold = thresholdArg;
    }
    if (Object.keys(patch).length === 0) {
      return {
        ok: true,
        blocks: [
          { kind: "text", text: tr("write.productUpdate.nothingToChange", locale) },
        ],
      };
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "update_product",
      params: { productId: target.id, patch },
      preview: { locale, productName: target.name, patch, categoryLabel },
    });

    const summary = buildUpdateProductSummary(locale, { patch, categoryLabel });
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.productUpdate.title", locale, { name: target.name }),
      summary,
      actionLabel: tr("write.productUpdate.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ────────────────────────── preview_create_brand ──────────────── */

export const previewCreateBrand: Tool = {
  name: "preview_create_brand",
  description:
    "PREVIEW the creation of a new brand in the tenant's brand master list. Call this when the user explicitly asks to add a brand ('ضيف براند', 'add a new brand'). Optional category_id scopes the brand to one category. Returns a confirmation block.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      category: { type: "string", description: "Optional — category name/key the brand belongs to." },
      category_id: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const locale = (ctx.locale ?? "en") as Locale;
    const name = str(args.name);
    if (!name) return askForFields(locale, ["name"]);

    // Short-circuit if a brand by that name already exists — we don't create
    // duplicates and the user shouldn't need to confirm a no-op.
    const existing = await resolveBrands(ctx.tenantId, name, { limit: 3 });
    const hit = existing.candidates.find((c) => c.tier === "HIGH");
    if (hit) {
      return {
        ok: true,
        blocks: [
          {
            kind: "text",
            text: tr("write.brandCreate.alreadyExists", locale, { name: hit.name }),
          },
        ],
      };
    }

    let categoryId: string | null = null;
    let categoryLabel: string | null = null;
    const categoryArg = str(args.category);
    const categoryIdArg = str(args.category_id);
    if (categoryIdArg) {
      const cats = await listCategories(ctx.tenantId, null);
      const direct = cats.find((c) => c.id === categoryIdArg);
      if (direct) {
        categoryId = direct.id;
        categoryLabel = direct.label;
      }
    }
    if (!categoryId && categoryArg) {
      const r = await resolveCategories(ctx.tenantId, categoryArg, { limit: 5 });
      const top = r.candidates[0];
      if (top && top.tier === "HIGH") {
        categoryId = top.id;
        categoryLabel = top.label;
      } else if (r.candidates.length > 0) {
        return clarifyCategoryAmbiguous(locale, categoryArg, r.candidates);
      }
      // No match for the optional category → silently drop; brand is created
      // category-agnostic.
    }

    const branchId = await resolveTenantPrimaryBranch(ctx.tenantId);
    if (!branchId) return { ok: false, error: "NO_TENANT_BRANCH" };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_brand",
      params: { name, categoryId, branchId },
      preview: { locale, name, categoryLabel },
    });

    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.brandCreate.title", locale, { name }),
      summary: categoryLabel
        ? tr("write.brandCreate.summaryScoped", locale, { name, category: categoryLabel })
        : tr("write.brandCreate.summary", locale, { name }),
      actionLabel: tr("write.brandCreate.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ────────────────────────── preview_create_category ──────────────── */

export const previewCreateCategory: Tool = {
  name: "preview_create_category",
  description:
    "PREVIEW the creation of a new category. Pass a human-readable label (e.g. 'Perfumes', 'برفانات'). The key is derived from the label (lowercased, non-alphanumerics replaced with '-') — the user never needs to specify it. Returns a confirmation block.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "User-visible category name." },
    },
    required: ["label"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const locale = (ctx.locale ?? "en") as Locale;
    const label = str(args.label);
    if (!label) return askForFields(locale, ["label"]);

    // Short-circuit if a category with this label (or key) already exists.
    const existing = await resolveCategories(ctx.tenantId, label, { limit: 3 });
    const hit = existing.candidates.find((c) => c.tier === "HIGH");
    if (hit) {
      return {
        ok: true,
        blocks: [
          {
            kind: "text",
            text: tr("write.categoryCreate.alreadyExists", locale, { label: hit.label }),
          },
        ],
      };
    }

    const key = deriveCategoryKey(label);
    const branchId = await resolveTenantPrimaryBranch(ctx.tenantId);
    if (!branchId) return { ok: false, error: "NO_TENANT_BRANCH" };

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_category",
      params: { key, label, branchId },
      preview: { locale, label },
    });

    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.categoryCreate.title", locale, { label }),
      summary: tr("write.categoryCreate.summary", locale, { label }),
      actionLabel: tr("write.categoryCreate.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ────────────────────────── helpers ────────────────────────────── */

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function int(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Math.trunc(n);
}

function askForFields(
  locale: Locale,
  missing: string[],
): { ok: true; blocks: AiBlock[] } {
  const labels = missing
    .map((f) => tr(`write.field.${f}`, locale))
    .join("، ");
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: tr("write.missingFields", locale, { fields: labels }),
      },
    ],
  };
}

function offerCreateCategory(
  locale: Locale,
  categoryName: string,
): { ok: true; blocks: AiBlock[] } {
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: tr("write.categoryUnknown", locale, { name: categoryName }),
      },
    ],
  };
}

function clarifyCategoryAmbiguous(
  locale: Locale,
  query: string,
  cands: Array<{ id: string; label: string }>,
): { ok: true; blocks: AiBlock[] } {
  const list = cands
    .slice(0, 5)
    .map((c) => `• ${c.label}`)
    .join("\n");
  return {
    ok: true,
    blocks: [
      {
        kind: "text",
        text: `${tr("write.categoryAmbiguous", locale, { query })}\n${list}`,
      },
    ],
  };
}

function buildCreateProductSummary(
  locale: Locale,
  input: {
    name: string;
    brand: string | null;
    categoryLabel: string | null;
    price: number;
    quantity: number;
    costPrice: number | null;
    lowStockThreshold: number;
  },
): string {
  const lines = [
    tr("write.productCreate.row.name", locale, { v: input.name }),
    tr("write.productCreate.row.category", locale, { v: input.categoryLabel ?? "—" }),
  ];
  if (input.brand) lines.push(tr("write.productCreate.row.brand", locale, { v: input.brand }));
  lines.push(
    tr("write.productCreate.row.price", locale, { v: fmtMoney(input.price) }),
  );
  lines.push(
    tr("write.productCreate.row.quantity", locale, { v: String(input.quantity) }),
  );
  if (input.costPrice !== null) {
    lines.push(tr("write.productCreate.row.cost", locale, { v: fmtMoney(input.costPrice) }));
  }
  return lines.join("\n");
}

function buildUpdateProductSummary(
  locale: Locale,
  input: { patch: Record<string, unknown>; categoryLabel: string | null },
): string {
  const parts: string[] = [];
  const p = input.patch;
  if (typeof p.name === "string") {
    parts.push(tr("write.productUpdate.row.name", locale, { v: p.name }));
  }
  if (p.brand !== undefined) {
    parts.push(
      tr("write.productUpdate.row.brand", locale, {
        v: typeof p.brand === "string" ? p.brand : "—",
      }),
    );
  }
  if (p.sku !== undefined) {
    parts.push(
      tr("write.productUpdate.row.sku", locale, {
        v: typeof p.sku === "string" ? p.sku : "—",
      }),
    );
  }
  if (p.categoryId) {
    parts.push(
      tr("write.productUpdate.row.category", locale, {
        v: input.categoryLabel ?? "—",
      }),
    );
  }
  if (typeof p.costPrice === "number") {
    parts.push(tr("write.productUpdate.row.cost", locale, { v: fmtMoney(p.costPrice) }));
  }
  if (typeof p.lowStockThreshold === "number") {
    parts.push(
      tr("write.productUpdate.row.threshold", locale, { v: String(p.lowStockThreshold) }),
    );
  }
  return parts.join("\n");
}

/** Deterministic key derivation from label so the user never has to think
 *  about keys. Falls back to a timestamp-ish random when stripping leaves
 *  nothing (e.g. pure-emoji label). */
function deriveCategoryKey(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || `cat-${Date.now().toString(36)}`;
}

async function resolveTenantPrimaryBranch(
  tenantId: string,
): Promise<string | null> {
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

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
