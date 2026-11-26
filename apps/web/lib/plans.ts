// Tenant-safe runtime read for plan content. Public + tenant routes call
// this when they need labels / prices / features. Reads the platform_plans
// table (single source of truth, edited via /admin/plans) with a 60-second
// in-memory cache. On DB error, falls back to the typed FALLBACK_PLANS in
// lib/payments/plans.ts so the landing page never blanks out.
//
// IMPORTANT: this module does NOT import @/lib/admin/db — that pool is
// BYPASSRLS and would expose tenant code to godmode. We use the regular
// tenant `db` instance. platform_plans has no tenant_id and is granted
// SELECT to matgary_app at the DB level, so unprivileged reads work fine.

import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformPlans } from "@/lib/db/schema";
import { PLANS as FALLBACK_PLANS, type PlanDefinition, type PlanKey } from "@/lib/payments/plans";
import { cacheBustPrefix, cacheRemember, globalKey } from "@/lib/cache";

export type Locale = "ar" | "en";

export interface PublicPlan {
  key: PlanKey;
  labelAr: string;
  labelEn: string;
  taglineAr: string;
  taglineEn: string;
  monthlyEgp: number;
  purchasable: boolean;
  featuresAr: string[];
  featuresEn: string[];
  sortOrder: number;
}

const CACHE_KEY = globalKey("plans", "public");
const CACHE_TTL_SEC = 60;

/** Read the current plan catalog. Cached in-memory for 60 s so the public
 *  landing page hit isn't an N+1 against the DB. Edits via /admin/plans
 *  bust the cache via bustPlansCache(). */
export async function getPlans(): Promise<PublicPlan[]> {
  try {
    return await cacheRemember(CACHE_KEY, CACHE_TTL_SEC, async () => {
      const rows = await db
        .select()
        .from(platformPlans)
        .orderBy(asc(platformPlans.sortOrder));
      if (rows.length === 0) {
        // No DB seed yet — return the typed fallback so the migration
        // window doesn't leave the landing page blank.
        return fallbackPlans();
      }
      return rows.map(
        (r): PublicPlan => ({
          key: r.key as PlanKey,
          labelAr: r.labelAr,
          labelEn: r.labelEn,
          taglineAr: r.taglineAr,
          taglineEn: r.taglineEn,
          monthlyEgp: r.monthlyEgp,
          purchasable: r.purchasable,
          featuresAr: r.featuresAr,
          featuresEn: r.featuresEn,
          sortOrder: r.sortOrder,
        }),
      );
    });
  } catch {
    return fallbackPlans();
  }
}

/** Get a single plan by key. Returns null when the key doesn't exist (e.g.
 *  a deprecated plan being referenced by an old subscription row). The
 *  caller chooses how to fall back; the billing routes default to the
 *  amount stored on the subscription row. */
export async function getPlan(key: PlanKey): Promise<PublicPlan | null> {
  const all = await getPlans();
  return all.find((p) => p.key === key) ?? null;
}

/** Synchronous typed fallback. Surfaces labels/tagline as both locales
 *  (defaults to the Arabic text the typed const has today; English fall
 *  back to the same Arabic text only as a last-ditch). */
function fallbackPlans(): PublicPlan[] {
  return Object.values(FALLBACK_PLANS).map((p: PlanDefinition, i): PublicPlan => ({
    key: p.key,
    labelAr: p.label,
    labelEn: p.label,
    taglineAr: p.tagline,
    taglineEn: p.tagline,
    monthlyEgp: p.monthlyEgp,
    purchasable: p.purchasable,
    featuresAr: p.features,
    featuresEn: p.features,
    sortOrder: i * 10,
  }));
}

/** Invoked by /admin/plans PATCH after a successful write so the next
 *  public read returns fresh content within ~1 second instead of waiting
 *  out the 60-second cache TTL. */
export async function bustPlansCache(): Promise<void> {
  await cacheBustPrefix(CACHE_KEY);
}
