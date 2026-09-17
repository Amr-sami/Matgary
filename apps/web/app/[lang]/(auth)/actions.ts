"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { BRANCH_NAME_COOKIE } from "@/lib/api/branch-name-cookie";
import { db, withTenant } from "@/lib/db";
import { tenants, shopSettings, branches } from "@/lib/db/schema";
import { signIn, signOut, auth, bustUserContextCache } from "@/lib/auth";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { logActivity } from "@/lib/repo/activity";
import { rateLimit } from "@/lib/ratelimit";
import {
  createAccount,
  type SignupErrorCode,
  type SignupField,
} from "@/lib/auth/create-account";
import { defaultLocale, isLocale, type Locale } from "@/lib/i18n/config";
import { normalizeEgyptPhoneAny } from "@/lib/validators/egypt";

// Public signup is wide open — cap it so a script can't churn out tenants.
// 5 / hour / IP is generous enough for legitimate retries on a flaky form.
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_SEC = 60 * 60;

async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() ?? "unknown";
}

// Middleware writes x-locale to every authenticated request based on the
// URL path. Server actions inherit those request headers, so we can read
// the locale here without needing the form to pass it.
async function activeLocale(): Promise<Locale> {
  const h = await headers();
  const raw = h.get("x-locale");
  return raw && isLocale(raw) ? raw : defaultLocale;
}

// All Zod messages here are stable IDENTIFIERS, not user-facing strings.
// The action returns a discriminated `code` and the client maps it to a
// localized message via the dictionary. Server stays locale-agnostic.
export type { SignupErrorCode, SignupField };

export type SignupResult =
  | { ok: true }
  | { ok: false; code: SignupErrorCode; field?: SignupField };

export async function signupAction(formData: FormData): Promise<SignupResult> {
  const ip = await clientIp();
  const limit = await rateLimit("signup.ip", ip, {
    limit: SIGNUP_LIMIT,
    windowSec: SIGNUP_WINDOW_SEC,
  });
  if (!limit.ok) {
    return { ok: false, code: "RATE_LIMITED" };
  }

  const locale = await activeLocale();
  const created = await createAccount(
    {
      email: formData.get("email"),
      password: formData.get("password"),
      storeName: formData.get("storeName"),
      storeHandle: formData.get("storeHandle"),
    },
    locale,
  );
  if (!created.ok) return created;

  const email = created.email;
  const password = String(formData.get("password") ?? "");

  try {
    await signIn("credentials", { email, password, redirect: false });
  } catch (err) {
    console.warn("[signup] auto-signIn failed:", err);
    return { ok: false, code: "AUTO_LOGIN_FAILED" };
  }

  return { ok: true };
}

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(128),
});

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function loginAction(formData: FormData): Promise<LoginResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, error: "بيانات غير صحيحة" };
  }
  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
    return { ok: true };
  } catch (err) {
    // CredentialsSignin is the expected wrong-password error. Anything else
    // (DB down, env missing) gets surfaced verbatim so we don't pretend it's
    // a credential issue.
    const name = (err as { name?: string } | undefined)?.name ?? "";
    if (name === "CredentialsSignin" || name === "CallbackRouteError") {
      return { ok: false, error: "البريد أو كلمة المرور غير صحيحة" };
    }
    console.error("[login] unexpected error", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "تعذر تسجيل الدخول",
    };
  }
}

const onboardingSchema = z.object({
  shopName: z.string().min(1).max(80),
  shopPhone: z.string().max(40).optional().or(z.literal("")),
  preset: z.enum(["cornerstore", "blank"]),
});

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

// Snapshot of the tenant the wizard pre-fills from. Returned by
// `getOnboardingDefaults()` so the page can render the values the user
// supplied at signup instead of asking again from scratch.
export interface OnboardingDefaults {
  shopName: string;
  shopPhone: string;
}

export async function getOnboardingDefaults(): Promise<OnboardingDefaults> {
  const session = await auth();
  if (!session?.user?.tenantId) return { shopName: "", shopPhone: "" };
  const tenantId = session.user.tenantId;
  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return { shopName: tenant?.name ?? "", shopPhone: "" };
}

export async function completeOnboardingAction(
  formData: FormData,
): Promise<OnboardingResult> {
  const session = await auth();
  if (!session?.user?.tenantId) {
    return { ok: false, code: "UNAUTHORIZED" };
  }

  const parsed = onboardingSchema.safeParse({
    shopName: formData.get("shopName"),
    shopPhone: formData.get("shopPhone") ?? "",
    preset: formData.get("preset"),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = String(first.path[0] ?? "");
    return {
      ok: false,
      code: path === "shopName" ? "SHOP_NAME_REQUIRED" : "INVALID_INPUT",
    };
  }

  // Normalize the phone to canonical `+201XXXXXXXXX` (or landline) so the
  // DB never stores free-form digit soup. Empty phone is allowed (optional
  // field); a typed-but-invalid phone trips INVALID_PHONE.
  let normalizedPhone: string | null = null;
  const rawPhone = (parsed.data.shopPhone ?? "").trim();
  if (rawPhone.length > 0) {
    normalizedPhone = normalizeEgyptPhoneAny(rawPhone);
    if (!normalizedPhone) {
      return { ok: false, code: "INVALID_PHONE" };
    }
  }

  const tenantId = session.user.tenantId;

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

      await tx
        .update(shopSettings)
        .set({
          shopName: parsed.data.shopName,
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

      if (parsed.data.preset === "cornerstore") {
        await seedCornerStorePreset(tx, tenantId, primary.id);
      }
    });
    // onboardingComplete just flipped — drop the cached context so the next
    // page render reflects it without waiting for the 60s TTL.
    await bustUserContextCache(session.user.id!);
  } catch (err) {
    console.error("[onboarding] failed", err);
    if ((err as { code?: string } | null)?.code === "PRIMARY_BRANCH_MISSING") {
      return { ok: false, code: "PRIMARY_BRANCH_MISSING" };
    }
    return { ok: false, code: "INTERNAL" };
  }

  return { ok: true };
}

export async function logoutAction() {
  // Capture session before signOut clears it, so the log row records who left.
  const session = await auth();
  if (session?.user?.tenantId && session.user.id) {
    await logActivity({
      tenantId: session.user.tenantId,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.email ?? null,
      action: "auth.logout",
      category: "auth",
      entityType: "user",
      entityId: session.user.id,
    });
  }
  // Clear the SSR branch-name cookie so the next user on this browser
  // doesn't see the previous tenant's branch heading flashed during
  // the next login's SSR render.
  const cookieStore = await cookies();
  cookieStore.delete(BRANCH_NAME_COOKIE);
  await signOut({ redirect: false });
  redirect("/login");
}
