// Admin-side plan repo. Reads + writes platform_plans through the BYPASSRLS
// pool. Every write busts the public plan cache so /api/plans reflects the
// change within ~1 second.

import { asc, eq } from "drizzle-orm";
import { admins, platformPlans } from "@/lib/db/schema";
import { bustPlansCache } from "@/lib/plans";
import { getAdminDb } from "./db";
import { logAuditEvent } from "./audit";

export interface AdminPlanRow {
  key: string;
  labelAr: string;
  labelEn: string;
  taglineAr: string;
  taglineEn: string;
  monthlyEgp: number;
  purchasable: boolean;
  featuresAr: string[];
  featuresEn: string[];
  sortOrder: number;
  updatedAt: Date;
  updatedByEmail: string | null;
}

export class PlanActionError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function listAdminPlans(): Promise<AdminPlanRow[]> {
  const db = getAdminDb();
  const rows = await db
    .select({
      key: platformPlans.key,
      labelAr: platformPlans.labelAr,
      labelEn: platformPlans.labelEn,
      taglineAr: platformPlans.taglineAr,
      taglineEn: platformPlans.taglineEn,
      monthlyEgp: platformPlans.monthlyEgp,
      purchasable: platformPlans.purchasable,
      featuresAr: platformPlans.featuresAr,
      featuresEn: platformPlans.featuresEn,
      sortOrder: platformPlans.sortOrder,
      updatedAt: platformPlans.updatedAt,
      updatedByAdminId: platformPlans.updatedByAdminId,
      updatedByEmail: admins.email,
    })
    .from(platformPlans)
    .leftJoin(admins, eq(admins.id, platformPlans.updatedByAdminId))
    .orderBy(asc(platformPlans.sortOrder));
  return rows.map((r) => ({
    key: r.key,
    labelAr: r.labelAr,
    labelEn: r.labelEn,
    taglineAr: r.taglineAr,
    taglineEn: r.taglineEn,
    monthlyEgp: r.monthlyEgp,
    purchasable: r.purchasable,
    featuresAr: r.featuresAr,
    featuresEn: r.featuresEn,
    sortOrder: r.sortOrder,
    updatedAt: r.updatedAt,
    updatedByEmail: r.updatedByEmail ?? null,
  }));
}

export interface PlanPatch {
  labelAr?: string;
  labelEn?: string;
  taglineAr?: string;
  taglineEn?: string;
  monthlyEgp?: number;
  purchasable?: boolean;
  featuresAr?: string[];
  featuresEn?: string[];
  sortOrder?: number;
}

export interface PatchPlanArgs {
  adminId: string;
  key: string;
  patch: PlanPatch;
  /** Optional optimistic-lock; PATCH header `If-Match: <updated_at ISO>`. */
  ifMatch?: string | null;
  meta: { ip: string | null; userAgent: string | null };
}

export async function patchPlan(args: PatchPlanArgs): Promise<AdminPlanRow> {
  const db = getAdminDb();
  const [existing] = await db
    .select()
    .from(platformPlans)
    .where(eq(platformPlans.key, args.key))
    .limit(1);
  if (!existing) {
    throw new PlanActionError("NOT_FOUND", "Plan not found", 404);
  }
  if (args.ifMatch) {
    const matchAt = new Date(args.ifMatch).getTime();
    if (Number.isNaN(matchAt) || matchAt !== existing.updatedAt.getTime()) {
      throw new PlanActionError(
        "STALE",
        "Another admin updated this plan since you opened the editor. Reload and retry.",
        409,
      );
    }
  }

  // Field validation — enforced redundantly with the Zod schema in the
  // route so the repo is safe to call directly in tests.
  const next: PlanPatch = args.patch;
  if (next.labelAr !== undefined) checkLen("labelAr", next.labelAr, 1, 80);
  if (next.labelEn !== undefined) checkLen("labelEn", next.labelEn, 1, 80);
  if (next.taglineAr !== undefined) checkLen("taglineAr", next.taglineAr, 1, 200);
  if (next.taglineEn !== undefined) checkLen("taglineEn", next.taglineEn, 1, 200);
  if (next.monthlyEgp !== undefined) {
    if (!Number.isInteger(next.monthlyEgp) || next.monthlyEgp < 0 || next.monthlyEgp > 99999) {
      throw new PlanActionError("INVALID_PRICE", "Price must be a non-negative integer < 100000", 400);
    }
  }
  if (next.featuresAr) checkFeatureList("featuresAr", next.featuresAr);
  if (next.featuresEn) checkFeatureList("featuresEn", next.featuresEn);
  if (next.sortOrder !== undefined) {
    if (!Number.isInteger(next.sortOrder) || next.sortOrder < 0 || next.sortOrder > 999) {
      throw new PlanActionError("INVALID_SORT", "sortOrder must be 0-999", 400);
    }
  }

  // AR/EN paired rule — if you touch one, you touch both. Avoids accidental
  // locale drift.
  if (
    (next.labelAr !== undefined) !== (next.labelEn !== undefined) ||
    (next.taglineAr !== undefined) !== (next.taglineEn !== undefined) ||
    (next.featuresAr !== undefined) !== (next.featuresEn !== undefined)
  ) {
    throw new PlanActionError(
      "LOCALE_PAIR_REQUIRED",
      "Send both Arabic and English when editing labels, taglines, or feature lists.",
      400,
    );
  }

  const now = new Date();
  await db
    .update(platformPlans)
    .set({
      labelAr: next.labelAr ?? existing.labelAr,
      labelEn: next.labelEn ?? existing.labelEn,
      taglineAr: next.taglineAr ?? existing.taglineAr,
      taglineEn: next.taglineEn ?? existing.taglineEn,
      monthlyEgp: next.monthlyEgp ?? existing.monthlyEgp,
      purchasable: next.purchasable ?? existing.purchasable,
      featuresAr: next.featuresAr ?? existing.featuresAr,
      featuresEn: next.featuresEn ?? existing.featuresEn,
      sortOrder: next.sortOrder ?? existing.sortOrder,
      updatedAt: now,
      updatedByAdminId: args.adminId,
    })
    .where(eq(platformPlans.key, args.key));

  await logAuditEvent({
    adminId: args.adminId,
    action: "plan.update",
    targetKind: "plan",
    // platform_plans is keyed by text, not uuid — store the key in
    // metadata since admin_audit_log.target_id is uuid-typed.
    targetId: null,
    ip: args.meta.ip,
    userAgent: args.meta.userAgent,
    before: {
      key: existing.key,
      labelAr: existing.labelAr,
      labelEn: existing.labelEn,
      taglineAr: existing.taglineAr,
      taglineEn: existing.taglineEn,
      monthlyEgp: existing.monthlyEgp,
      purchasable: existing.purchasable,
      featuresAr: existing.featuresAr,
      featuresEn: existing.featuresEn,
      sortOrder: existing.sortOrder,
    },
    after: {
      key: existing.key,
      labelAr: next.labelAr ?? existing.labelAr,
      labelEn: next.labelEn ?? existing.labelEn,
      taglineAr: next.taglineAr ?? existing.taglineAr,
      taglineEn: next.taglineEn ?? existing.taglineEn,
      monthlyEgp: next.monthlyEgp ?? existing.monthlyEgp,
      purchasable: next.purchasable ?? existing.purchasable,
      featuresAr: next.featuresAr ?? existing.featuresAr,
      featuresEn: next.featuresEn ?? existing.featuresEn,
      sortOrder: next.sortOrder ?? existing.sortOrder,
    },
  });

  // Bust the public cache so /api/plans serves fresh content immediately.
  await bustPlansCache();

  const [updated] = await db
    .select()
    .from(platformPlans)
    .where(eq(platformPlans.key, args.key))
    .limit(1);
  return {
    key: updated.key,
    labelAr: updated.labelAr,
    labelEn: updated.labelEn,
    taglineAr: updated.taglineAr,
    taglineEn: updated.taglineEn,
    monthlyEgp: updated.monthlyEgp,
    purchasable: updated.purchasable,
    featuresAr: updated.featuresAr,
    featuresEn: updated.featuresEn,
    sortOrder: updated.sortOrder,
    updatedAt: updated.updatedAt,
    updatedByEmail: null,
  };
}

function checkLen(field: string, value: string, min: number, max: number) {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new PlanActionError(
      "INVALID_LENGTH",
      `${field} must be ${min}-${max} characters`,
      400,
    );
  }
}

function checkFeatureList(field: string, list: string[]) {
  if (list.length > 15) {
    throw new PlanActionError(
      "TOO_MANY_FEATURES",
      `${field} can hold up to 15 items`,
      400,
    );
  }
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (typeof item !== "string" || item.trim().length < 1 || item.length > 200) {
      throw new PlanActionError(
        "INVALID_FEATURE",
        `${field}[${i}] must be 1-200 characters`,
        400,
      );
    }
  }
}
