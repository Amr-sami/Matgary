import { listBrands } from "@/lib/repo/catalog";

import { canonical, score } from "../normalize";

/**
 * Wave 1 — Brand resolver.
 *
 * Mirrors the product resolver pattern: returns ONLY real tenant-scoped
 * rows ranked by canonicalised score. The agent never invents a brand — it
 * either picks a HIGH match, surfaces a clarification, or (when the user
 * clearly asked to create one) hands off to preview_create_brand.
 *
 * Score thresholds mirror the F-plan §5 copy:
 *   ≥ 0.95   HIGH    — safe to auto-resolve
 *   0.85-0.95 MEDIUM — one candidate still likely
 *   0.55-0.85 LOW    — ask the user to pick
 *   < 0.55   NONE    — no confident match
 *
 * Arabic / English / Egyptian handling is inherited from `canonical` which
 * already folds Arabic diacritics, hamza variants, and Arabic-Indic digits.
 */

export type BrandTier = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface ResolvedBrand {
  id: string;
  name: string;
  categoryId: string | null;
  score: number;
  tier: BrandTier;
}

export interface BrandResolveResult {
  query: string;
  candidates: ResolvedBrand[];
}

export async function resolveBrands(
  tenantId: string,
  query: string,
  opts: { limit?: number; minScore?: number } = {},
): Promise<BrandResolveResult> {
  const q = query.trim();
  if (!q) return { query: q, candidates: [] };
  const qCanonical = canonical(q);

  const rows = await listBrands(tenantId, null);
  const scored = rows
    .map((r) => {
      const s = score(qCanonical, canonical(r.name));
      return {
        id: r.id,
        name: r.name,
        categoryId: r.categoryId ?? null,
        score: s,
        tier: tierForScore(s),
      } satisfies ResolvedBrand;
    })
    .filter((r) => r.score >= (opts.minScore ?? 0.55))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);

  return { query: q, candidates: scored };
}

function tierForScore(s: number): BrandTier {
  if (s >= 0.95) return "HIGH";
  if (s >= 0.85) return "MEDIUM";
  if (s >= 0.55) return "LOW";
  return "NONE";
}

/** Convenience — picks the single HIGH-confidence brand if there's exactly
 *  one, else returns null. The caller surfaces a clarification. */
export async function resolveSingleBrand(
  tenantId: string,
  query: string,
): Promise<ResolvedBrand | null> {
  const r = await resolveBrands(tenantId, query, { minScore: 0.95, limit: 2 });
  if (r.candidates.length === 1) return r.candidates[0]!;
  return null;
}
