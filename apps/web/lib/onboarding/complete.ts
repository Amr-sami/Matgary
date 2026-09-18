import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/lib/db";
import { shopSettings, branches } from "@/lib/db/schema";
import { bustUserContextCache } from "@/lib/auth";
import { cacheDel, tenantKey } from "@/lib/cache";
import { bustCatalogCache } from "@/lib/repo/catalog";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import type { Locale } from "@/lib/i18n/config";
import { normalizeEgyptPhoneAny } from "@/lib/validators/egypt";

/**
 * Onboarding completion, transport-agnostic.
 *
 * Two callers share this: the web wizard's Server Action
 * (app/[lang]/(auth)/actions.ts → completeOnboardingAction, FormData in) and
 * the native app's POST /api/v1/onboarding/complete (bearer, JSON in). Both
 * validate their own envelope with `parseOnboardingInput` and hand the typed
 * input here, so the DB work — primary-branch settings row + preset seed +
 * user-context cache bust — exists exactly once.
 */

export const onboardingSchema = z.object({
  shopName: z.string().min(1).max(80),
  shopPhone: z.string().max(40).optional().or(z.literal("")),
  preset: z.enum(["cornerstore", "blank"]),
});

export type OnboardingPreset = z.infer<typeof onboardingSchema>["preset"];

export interface OnboardingInput {
  preset: OnboardingPreset;
  shopName: string;
  /** Free-form; normalised to `+201XXXXXXXXX` / landline here. Empty = none. */
  shopPhone?: string | null;
}

export type OnboardingErrorCode =
  | "UNAUTHORIZED"
  | "SHOP_NAME_REQUIRED"
  | "INVALID_PHONE"
  | "INVALID_INPUT"
  | "PRIMARY_BRANCH_MISSING"
  | "INTERNAL";

export type OnboardingResult =
  | { ok: true }
  | { ok: false; code: OnboardingErrorCode };

/**
 * Shape-check a raw envelope (FormData fields or a JSON body) and map the
 * first zod issue to the wizard's error code. Phone validity is NOT checked
 * here — that is `completeOnboarding`'s INVALID_PHONE.
 */
export function parseOnboardingInput(
  raw: unknown,
): { ok: true; data: OnboardingInput } | { ok: false; code: OnboardingErrorCode } {
  const parsed = onboardingSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = String(first?.path[0] ?? "");
    return {
      ok: false,
      code: path === "shopName" ? "SHOP_NAME_REQUIRED" : "INVALID_INPUT",
    };
  }
  return { ok: true, data: parsed.data };
}

export async function completeOnboarding(
  tenantId: string,
  userId: string,
  input: OnboardingInput,
  locale: Locale,
): Promise<OnboardingResult> {
  const shopName = input.shopName.trim();
  if (shopName.length === 0) return { ok: false, code: "SHOP_NAME_REQUIRED" };

  // Normalize the phone to canonical `+201XXXXXXXXX` (or landline) so the
  // DB never stores free-form digit soup. Empty phone is allowed (optional
  // field); a typed-but-invalid phone trips INVALID_PHONE.
  let normalizedPhone: string | null = null;
  const rawPhone = (input.shopPhone ?? "").trim();
  if (rawPhone.length > 0) {
    normalizedPhone = normalizeEgyptPhoneAny(rawPhone);
    if (!normalizedPhone) {
      return { ok: false, code: "INVALID_PHONE" };
    }
  }

  let primaryBranchId: string | null = null;
  try {
    await withTenant(tenantId, async (tx) => {
      // Onboarding fills the tenant's primary-branch settings row + seeds
      // its catalog. Multi-store: secondary branches are created later from
      // /settings/branches and start empty by design.
      const [primary] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true)),
        )
        .limit(1);
      if (!primary) {
        // Sentinel so the catch below can return the typed code instead of
        // a generic INTERNAL — primary-branch-missing is recoverable
        // (admin can fix) and worth surfacing distinctly.
        throw Object.assign(new Error("PRIMARY_BRANCH_MISSING"), {
          code: "PRIMARY_BRANCH_MISSING",
        });
      }
      primaryBranchId = primary.id;

      await tx
        .update(shopSettings)
        .set({
          shopName,
          shopPhone: normalizedPhone,
          onboardingCompletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shopSettings.tenantId, tenantId),
            eq(shopSettings.branchId, primary.id),
          ),
        );

      if (input.preset === "cornerstore") {
        // Idempotent: skips when the tenant already has any category.
        await seedCornerStorePreset(tx, tenantId, primary.id);
      }
    });
    // onboardingComplete just flipped — drop the cached context so the next
    // page render / /api/v1/me reflects it without waiting for the 60s TTL.
    await bustUserContextCache(userId);
    // The native app may already have read (and cached server-side, 300s)
    // an empty catalog and the blank settings row before finishing the
    // wizard — the browser never does, so the action never needed this.
    // Same key as lib/repo/settings.ts's settingsKey (module-private there).
    await Promise.all([
      bustCatalogCache(tenantId),
      primaryBranchId ? cacheDel(tenantKey(tenantId, "settings", primaryBranchId)) : null,
    ]);
  } catch (err) {
    console.error("[onboarding] failed", { tenantId, userId, locale, preset: input.preset }, err);
    if ((err as { code?: string } | null)?.code === "PRIMARY_BRANCH_MISSING") {
      return { ok: false, code: "PRIMARY_BRANCH_MISSING" };
    }
    return { ok: false, code: "INTERNAL" };
  }

  return { ok: true };
}
