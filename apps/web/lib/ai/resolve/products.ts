import { findProductBySku, listProducts } from "@/lib/repo/catalog";
import type { Product } from "@/lib/types";

import { canonical, normalizeSku, score } from "../normalize";

/**
 * Entity-resolution layer for products.
 *
 * Why this exists: Gemini must NEVER invent a product. Before the model can
 * answer any product question, the agent calls this resolver, which returns
 * ONLY real database rows ranked by confidence. The model then picks from the
 * candidates (or asks the user when multiple are plausible).
 *
 * Confidence contract (score ∈ [0,1], threshold copy per the F-plan §5):
 *   ≥ 0.95   HIGH    — safe to auto-resolve
 *   0.85-0.95 MEDIUM — one candidate still likely, but surface it
 *   0.55-0.85 LOW    — show list, ask the user to pick
 *   < 0.55   NONE    — no confident match
 *
 * The resolver RETURNS candidates with their confidence tier; it does NOT
 * decide "which one is right". That decision is the orchestrator's job once
 * it sees user intent.
 */

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface ResolvedProduct {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  price: number;
  costPrice: number | null;
  quantity: number;
  lowStockThreshold: number;
  categoryId: string;
  imageUrl: string | null;
  /** 0–1 score for how well this product matches the query. */
  score: number;
  tier: ConfidenceTier;
  /** Which field(s) earned the match (diagnostic + UX — "matched on SKU"). */
  matchedOn: Array<"name" | "brand" | "sku">;
}

export interface ResolveProductsOptions {
  /** Cap returned candidates. Default 10. */
  limit?: number;
  /** Floor on score to include. Default 0.55 (LOW tier). */
  minScore?: number;
}

export interface ResolveProductsResult {
  query: string;
  canonicalQuery: string;
  totalScanned: number;
  candidates: ResolvedProduct[];
  /** Top tier among `candidates` (NONE when empty). Lets the caller decide
   *  whether to answer, clarify or refuse without re-scanning. */
  topTier: ConfidenceTier;
  /** Source metadata — F-plan §9. Mobile never sees this; logs + validation only. */
  source: {
    name: "storo_database";
    entity: "product";
    tenantId: string;
    branchId: string | null;
    retrievedAt: string;
  };
}

export async function resolveProducts(
  args: {
    tenantId: string;
    branchId: string | null;
    query: string;
  },
  opts: ResolveProductsOptions = {},
): Promise<ResolveProductsResult> {
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0.55;
  const retrievedAt = new Date().toISOString();

  const q = args.query.trim();
  const qCanonical = canonical(q);
  const qSku = normalizeSku(q);

  // SKU/barcode short-circuit — fast + exact via the SKU expression index.
  if (qSku.length >= 4 && /\d/.test(qSku)) {
    const skuHits = await findProductBySku(args.tenantId, qSku);
    // Scope to active branch when the user is branch-pinned. Owner "all
    // branches" view sees every branch's result (ordered by in-stock first,
    // which findProductBySku already sorts).
    const scoped = args.branchId
      ? skuHits.filter((h) => h.branchId === args.branchId)
      : skuHits;
    if (scoped.length > 0) {
      return {
        query: q,
        canonicalQuery: qCanonical,
        totalScanned: scoped.length,
        candidates: scoped.map((h) => toResolved(h.product, 1, "HIGH", ["sku"])),
        topTier: "HIGH",
        source: {
          name: "storo_database",
          entity: "product",
          tenantId: args.tenantId,
          branchId: args.branchId,
          retrievedAt,
        },
      };
    }
  }

  // General candidate scan. Loads tenant+branch products and scores client-side.
  // Known limitation (documented in grounding policy): O(n) per query, scales
  // to ~10k products per branch before needing pg_trgm + fulltext.
  const all = await listProducts(args.tenantId, args.branchId);

  const scored: ResolvedProduct[] = [];
  for (const p of all) {
    const { s, matchedOn } = scoreProduct(q, p);
    if (s >= minScore) {
      scored.push(toResolved(p, s, tierFor(s), matchedOn));
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, limit);
  const topTier: ConfidenceTier = candidates[0]?.tier ?? "NONE";

  return {
    query: q,
    canonicalQuery: qCanonical,
    totalScanned: all.length,
    candidates,
    topTier,
    source: {
      name: "storo_database",
      entity: "product",
      tenantId: args.tenantId,
      branchId: args.branchId,
      retrievedAt,
    },
  };
}

function scoreProduct(
  query: string,
  p: Product,
): { s: number; matchedOn: Array<"name" | "brand" | "sku"> } {
  const fields: Array<{ field: "name" | "brand" | "sku"; value: string | null | undefined }> = [
    { field: "name", value: p.name },
    { field: "brand", value: p.brand },
    { field: "sku", value: p.sku },
  ];
  let best = 0;
  const hits: Array<"name" | "brand" | "sku"> = [];
  for (const { field, value } of fields) {
    if (!value) continue;
    const s = score(query, value);
    if (s > 0) hits.push(field);
    if (s > best) best = s;
  }
  // Boost when matched on multiple fields (name AND brand both hit "Casio watch").
  if (hits.length >= 2 && best < 1) best = Math.min(1, best + 0.03);
  return { s: best, matchedOn: hits };
}

function tierFor(s: number): ConfidenceTier {
  if (s >= 0.95) return "HIGH";
  if (s >= 0.85) return "MEDIUM";
  if (s >= 0.55) return "LOW";
  return "NONE";
}

function toResolved(
  p: Product,
  score: number,
  tier: ConfidenceTier,
  matchedOn: Array<"name" | "brand" | "sku">,
): ResolvedProduct {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand ?? null,
    sku: p.sku ?? null,
    price: Number(p.price ?? 0),
    costPrice: p.costPrice != null ? Number(p.costPrice) : null,
    quantity: p.quantity,
    lowStockThreshold: p.lowStockThreshold,
    categoryId: p.category,
    imageUrl: p.imageUrl ?? null,
    score,
    tier,
    matchedOn,
  };
}
