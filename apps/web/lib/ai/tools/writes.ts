import { customerWallets } from "@/lib/db/schema";
import { listProducts } from "@/lib/repo/catalog";
import { withTenant } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { normalizeEgyptPhoneAny } from "@/lib/validators/egypt";

import { tr } from "../i18n";
import { createPending } from "../write/pending";
import { resolveProducts } from "../resolve/products";
import type { Tool } from "./types";
import type { AiBlock, Locale } from "../responses";

/**
 * F5 — Preview tools. These NEVER mutate. Each resolves the target, computes
 * the new value deterministically, stores a server-side pending action, and
 * returns a `confirmation` block the mobile client taps to execute.
 *
 * The model is instructed (via system prompt) to call these INSTEAD of trying
 * to describe a write in prose. Actual execution happens in /api/ai/confirm.
 */

/* ────────────────────────── preview_update_product_price ──────────────── */

export const previewUpdateProductPrice: Tool = {
  name: "preview_update_product_price",
  description:
    "PREVIEW a price change for a product. Resolves the product first (NEVER accept a product_id the model made up). Supports mode='set' (newPrice is the final price), mode='increase_by' / 'decrease_by' (newPrice is an absolute amount), and mode='increase_pct' / 'decrease_pct' (newPrice is a 0-100 percentage). The backend computes the final price deterministically. Returns a confirmation block the user taps to execute. Never writes.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "uuid returned by search_products / get_product." },
      query: { type: "string", description: "Fallback — resolve by name/sku/brand when product_id is not available." },
      mode: {
        type: "string",
        enum: ["set", "increase_by", "decrease_by", "increase_pct", "decrease_pct"],
      },
      value: { type: "number", description: "The absolute amount (EGP) or percentage (0-100)." },
    },
    required: ["mode", "value"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = await resolveTargetProduct(ctx, args);
    const localeForClarify = (ctx.locale ?? "en") as Locale;
    if (resolved.kind === "none") return clarifyNone(resolved.query, localeForClarify);
    if (resolved.kind === "ambiguous")
      return clarifyAmbiguous(resolved.candidates, localeForClarify);
    const p = resolved.product;

    const mode = String(args.mode);
    const value = Number(args.value);
    if (!Number.isFinite(value)) return { ok: false, error: "INVALID_VALUE" };
    const current = Number(p.price);
    let newPrice: number;
    switch (mode) {
      case "set":
        newPrice = round2(value);
        break;
      case "increase_by":
        newPrice = round2(current + value);
        break;
      case "decrease_by":
        newPrice = round2(current - value);
        break;
      case "increase_pct":
        newPrice = round2(current * (1 + value / 100));
        break;
      case "decrease_pct":
        newPrice = round2(current * (1 - value / 100));
        break;
      default:
        return { ok: false, error: "UNKNOWN_MODE" };
    }
    if (newPrice < 0) {
      return {
        ok: false,
        error: "INVALID_RESULT",
        reason: "New price would be negative.",
      };
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "update_product_price",
      params: { productId: p.id, newPrice },
      preview: {
        locale: ctx.locale ?? "en",
        productName: p.name,
        productSku: p.sku,
        currentPrice: current,
        newPrice,
        mode,
      },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const title = tr("write.price.title", locale, { name: p.name });
    const summary = tr("write.price.summary", locale, {
      before: fmtMoney(current),
      after: fmtMoney(newPrice),
    });
    const actionLabel = tr("write.price.actionLabel", locale);

    const block: AiBlock = {
      kind: "confirmation",
      title,
      summary,
      actionLabel,
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ──────────────────────── preview_update_product_quantity ─────────────── */

export const previewUpdateProductQuantity: Tool = {
  name: "preview_update_product_quantity",
  description:
    "PREVIEW a stock change for a product. mode='set' replaces the quantity with `value`; mode='increase' adds `value`; mode='decrease' subtracts `value`. Resolves the product first. Returns a confirmation block.",
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      query: { type: "string" },
      mode: { type: "string", enum: ["set", "increase", "decrease"] },
      value: { type: "integer", minimum: 0 },
    },
    required: ["mode", "value"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const resolved = await resolveTargetProduct(ctx, args);
    const localeForClarify = (ctx.locale ?? "en") as Locale;
    if (resolved.kind === "none") return clarifyNone(resolved.query, localeForClarify);
    if (resolved.kind === "ambiguous")
      return clarifyAmbiguous(resolved.candidates, localeForClarify);
    const p = resolved.product;

    const mode = String(args.mode);
    const value = Math.floor(Number(args.value));
    if (!Number.isFinite(value) || value < 0) return { ok: false, error: "INVALID_VALUE" };
    const current = p.quantity;
    let projectedQty: number;
    switch (mode) {
      case "set":
        projectedQty = value;
        break;
      case "increase":
        projectedQty = current + value;
        break;
      case "decrease":
        projectedQty = current - value;
        break;
      default:
        return { ok: false, error: "UNKNOWN_MODE" };
    }
    if (projectedQty < 0) {
      return {
        ok: false,
        error: "INVALID_RESULT",
        reason: `Would leave quantity at ${projectedQty}.`,
      };
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "update_product_quantity",
      params: { productId: p.id, mode, value },
      preview: {
        locale: ctx.locale ?? "en",
        productName: p.name,
        currentQty: current,
        projectedQty,
        mode,
      },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const title = tr("write.quantity.title", locale, { name: p.name });
    const summary = tr("write.quantity.summary", locale, {
      before: current,
      after: projectedQty,
    });
    const actionLabel = tr("write.quantity.actionLabel", locale);

    const block: AiBlock = {
      kind: "confirmation",
      title,
      summary,
      actionLabel,
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ──────────────────────────── preview_create_customer ─────────────────── */

export const previewCreateCustomer: Tool = {
  name: "preview_create_customer",
  description:
    "PREVIEW the creation of a new customer. Requires a name and an Egyptian phone. If the phone already exists in this branch, reports that instead. Returns a confirmation block.",
  requiredPermission: "record_sales",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      phone: { type: "string", minLength: 8, description: "Egyptian phone — 01x... or +201x..." },
    },
    required: ["name", "phone"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const name = String(args.name ?? "").trim();
    const phoneRaw = String(args.phone ?? "");
    const phone = normalizeEgyptPhoneAny(phoneRaw);
    if (!phone || !name) {
      return { ok: false, error: "INVALID_PARAMS", reason: "Need both a name and a valid Egyptian phone." };
    }
    // Idempotency hint — not a guarantee (the row might be created
    // concurrently between preview and confirm). Tenant-scoped (Storo has
    // no branch feature); the executor resolves the wallet's legacy
    // branch_id column at write time.
    const existing = await withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(customerWallets)
        .where(
          and(
            eq(customerWallets.tenantId, ctx.tenantId),
            eq(customerWallets.customerPhone, phone),
          ),
        );
      return row ?? null;
    });

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_customer",
      params: { name, phone },
      preview: {
        locale: ctx.locale ?? "en",
        name,
        phone,
        alreadyExists: Boolean(existing),
      },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const title = tr("write.customer.title", locale);
    const summary = existing
      ? tr("write.customer.summary.alreadyExists", locale, {
          label: existing.customerName ?? phone,
        })
      : `${name} · ${phone}`;
    const actionLabel = tr("write.customer.actionLabel", locale);

    const block: AiBlock = {
      kind: "confirmation",
      title,
      summary,
      actionLabel,
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ─────────────────────────────── helpers ──────────────────────────────── */

type ResolvedTarget =
  | { kind: "ok"; product: NonNullable<Awaited<ReturnType<typeof getProductByIdInline>>> }
  | { kind: "none"; query: string }
  | { kind: "ambiguous"; candidates: Array<{ id: string; name: string; brand: string | null }> };

async function resolveTargetProduct(
  ctx: Parameters<Tool["handler"]>[0],
  args: Record<string, unknown>,
): Promise<ResolvedTarget> {
  const productId = typeof args.product_id === "string" ? args.product_id : "";
  if (productId) {
    const p = await getProductByIdInline(ctx.tenantId, null,productId);
    if (p) return { kind: "ok", product: p };
    // product_id didn't resolve — fall through to query if provided.
  }
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) return { kind: "none", query: productId || "" };
  const r = await resolveProducts(
    { tenantId: ctx.tenantId, branchId: null, query },
    { limit: 5 },
  );
  if (r.candidates.length === 0) return { kind: "none", query };
  // Writes require HIGH or a single MEDIUM/LOW candidate. Multiple results →
  // ambiguous: ask the user. (F-plan §5 — "never silently select a low-
  // confidence candidate for a destructive/financial action.")
  const topScore = r.candidates[0]!.score;
  const confident = r.candidates.filter((c) => c.score === topScore);
  if (confident.length === 1 && topScore >= 0.95) {
    const p = await getProductByIdInline(ctx.tenantId, null,confident[0]!.id);
    if (p) return { kind: "ok", product: p };
  }
  return {
    kind: "ambiguous",
    candidates: r.candidates.slice(0, 5).map((c) => ({ id: c.id, name: c.name, brand: c.brand })),
  };
}

async function getProductByIdInline(
  tenantId: string,
  branchId: string | null,
  id: string,
) {
  const all = await listProducts(tenantId, branchId);
  return all.find((p) => p.id === id) ?? null;
}

function clarifyNone(query: string, locale: Locale): { ok: true; blocks: AiBlock[] } {
  return {
    ok: true,
    blocks: [{ kind: "text", text: tr("resolve.noMatch", locale, { query }) }],
  };
}

function clarifyAmbiguous(
  cands: Array<{ id: string; name: string; brand: string | null }>,
  locale: Locale,
): { ok: true; blocks: AiBlock[] } {
  const list = cands.map((c) => `• ${c.name}${c.brand ? ` (${c.brand})` : ""}`).join("\n");
  return {
    ok: true,
    blocks: [
      { kind: "text", text: `${tr("resolve.ambiguousHeader", locale)}\n${list}` },
    ],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
