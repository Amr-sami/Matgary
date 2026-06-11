// Tenant-safe read for platform_broadcasts. Used by the public
// /api/broadcasts endpoint AppShell hits on the client.
//
// platform_broadcasts has no tenant_id and is granted SELECT to matgary_app
// at the DB layer, so this uses the regular tenant pool (NOT the admin
// BYPASSRLS pool). The cache is busted by admin writes via
// bustBroadcastsCache().

import { and, asc, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformBroadcasts } from "@/lib/db/schema";
import { cacheBustPrefix, cacheRemember, globalKey } from "@/lib/cache";

export type BroadcastSeverity = "info" | "warning" | "critical";
export type BroadcastAudience = "all" | "owners" | "staff";

export interface PublicBroadcast {
  id: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  severity: BroadcastSeverity;
  audience: BroadcastAudience;
  startsAt: string;
  endsAt: string | null;
}

const CACHE_KEY = globalKey("broadcasts", "active");
const CACHE_TTL_SEC = 60;

/** All currently-active broadcasts (window open + matching audience for the
 *  caller). 60-second cache; busted by admin writes. */
export async function getActiveBroadcasts(
  forRole: "owner" | "staff",
  now: Date = new Date(),
): Promise<PublicBroadcast[]> {
  const all = await getAllActive(now);
  return all.filter((b) => {
    if (b.audience === "all") return true;
    if (b.audience === "owners") return forRole === "owner";
    return forRole === "staff";
  });
}

async function getAllActive(now: Date): Promise<PublicBroadcast[]> {
  try {
    return await cacheRemember(CACHE_KEY, CACHE_TTL_SEC, async () => {
      const rows = await db
        .select()
        .from(platformBroadcasts)
        .where(
          and(
            lte(platformBroadcasts.startsAt, now),
            or(isNull(platformBroadcasts.endsAt), gt(platformBroadcasts.endsAt, now))!,
          ),
        )
        .orderBy(asc(platformBroadcasts.severity), asc(platformBroadcasts.startsAt));
      return rows.map(
        (r): PublicBroadcast => ({
          id: r.id,
          titleAr: r.titleAr,
          titleEn: r.titleEn,
          bodyAr: r.bodyAr,
          bodyEn: r.bodyEn,
          severity: r.severity as BroadcastSeverity,
          audience: r.audience as BroadcastAudience,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt?.toISOString() ?? null,
        }),
      );
    });
  } catch {
    // DB unreachable — no broadcasts is the safe default (the user simply
    // doesn't see banners, no error surface to them).
    return [];
  }
}

/** Drop the cache after an admin write so the next public read returns the
 *  fresh state within a second instead of waiting out the 60 s TTL. */
export async function bustBroadcastsCache(): Promise<void> {
  await cacheBustPrefix(CACHE_KEY);
}

void sql;
