import { listCategories } from "@/lib/repo/catalog";

import { canonical, score } from "../normalize";

/**
 * Wave 1 — Category resolver.
 *
 * Tenant-scoped lookup by canonical key OR label. Matches on both to catch
 * the common Storo pattern where the KEY is an English slug ("perfumes")
 * and the LABEL is the user-visible string ("برفانات" / "Perfumes"). The
 * score is the max of the two independent scores.
 */

export type CategoryTier = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface ResolvedCategory {
  id: string;
  key: string;
  label: string;
  score: number;
  tier: CategoryTier;
}

export interface CategoryResolveResult {
  query: string;
  candidates: ResolvedCategory[];
}

export async function resolveCategories(
  tenantId: string,
  query: string,
  opts: { limit?: number; minScore?: number } = {},
): Promise<CategoryResolveResult> {
  const q = query.trim();
  if (!q) return { query: q, candidates: [] };
  const qCanonical = canonical(q);

  const rows = await listCategories(tenantId, null);
  const scored = rows
    .map((r) => {
      const byKey = score(qCanonical, canonical(r.key));
      const byLabel = score(qCanonical, canonical(r.label));
      const s = Math.max(byKey, byLabel);
      return {
        id: r.id,
        key: r.key,
        label: r.label,
        score: s,
        tier: tierForScore(s),
      } satisfies ResolvedCategory;
    })
    .filter((r) => r.score >= (opts.minScore ?? 0.55))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);

  return { query: q, candidates: scored };
}

function tierForScore(s: number): CategoryTier {
  if (s >= 0.95) return "HIGH";
  if (s >= 0.85) return "MEDIUM";
  if (s >= 0.55) return "LOW";
  return "NONE";
}

/** Convenience — picks the single HIGH-confidence category if there's
 *  exactly one, else returns null. The caller surfaces a clarification. */
export async function resolveSingleCategory(
  tenantId: string,
  query: string,
): Promise<ResolvedCategory | null> {
  const r = await resolveCategories(tenantId, query, { minScore: 0.95, limit: 2 });
  if (r.candidates.length === 1) return r.candidates[0]!;
  return null;
}
