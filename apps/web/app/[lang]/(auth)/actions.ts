"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { BRANCH_NAME_COOKIE } from "@/lib/api/branch-name-cookie";
import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { signIn, signOut, auth } from "@/lib/auth";
import {
  completeOnboarding,
  parseOnboardingInput,
  type OnboardingErrorCode,
  type OnboardingResult,
} from "@/lib/onboarding/complete";
import { logActivity } from "@/lib/repo/activity";
import { rateLimit } from "@/lib/ratelimit";
import {
  createAccount,
  type SignupErrorCode,
  type SignupField,
} from "@/lib/auth/create-account";
import { defaultLocale, isLocale, type Locale } from "@/lib/i18n/config";

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

// Schema, codes and the DB work live in lib/onboarding/complete.ts, shared
// with POST /api/v1/onboarding/complete (the native app's transport).
export type { OnboardingErrorCode, OnboardingResult };

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

  const parsed = parseOnboardingInput({
    shopName: formData.get("shopName"),
    shopPhone: formData.get("shopPhone") ?? "",
    preset: formData.get("preset"),
  });
  if (!parsed.ok) return parsed;

  return completeOnboarding(
    session.user.tenantId,
    session.user.id!,
    parsed.data,
    await activeLocale(),
  );
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
