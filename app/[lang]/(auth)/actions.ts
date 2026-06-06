"use server";

import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { db, withTenant } from "@/lib/db";
import {
  users,
  tenants,
  tenantMembers,
  shopSettings,
  branches,
} from "@/lib/db/schema";
import { signIn, signOut, auth, bustUserContextCache } from "@/lib/auth";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { logActivity } from "@/lib/repo/activity";
import { rateLimit } from "@/lib/ratelimit";
import { ensureSubscription } from "@/lib/repo/subscriptions";
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
const signupSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8).max(128),
  storeName: z.string().min(1).max(80),
  // The store handle becomes the @-suffix of every staff login (ahmed@<handle>).
  // Owner-chosen and editable so they end up with something they can actually
  // dictate to their cashier — auto-derived slugs from Arabic names produce
  // unusable random strings.
  storeHandle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});

export type SignupErrorCode =
  | "RATE_LIMITED"
  | "BAD_EMAIL_FORMAT"
  | "WEAK_PASSWORD"
  | "STORE_NAME_REQUIRED"
  | "HANDLE_INVALID"
  | "EMAIL_TAKEN"
  | "HANDLE_TAKEN"
  | "AUTO_LOGIN_FAILED"
  | "INTERNAL";

export type SignupField = "email" | "password" | "storeName" | "storeHandle";

export type SignupResult =
  | { ok: true }
  | { ok: false; code: SignupErrorCode; field?: SignupField };

// Map zod path → code so the per-field validation message is locale-agnostic.
function signupCodeForField(field: SignupField | undefined): SignupErrorCode {
  switch (field) {
    case "email":
      return "BAD_EMAIL_FORMAT";
    case "password":
      return "WEAK_PASSWORD";
    case "storeName":
      return "STORE_NAME_REQUIRED";
    case "storeHandle":
    default:
      return "HANDLE_INVALID";
  }
}

export async function signupAction(formData: FormData): Promise<SignupResult> {
  const ip = await clientIp();
  const limit = await rateLimit("signup.ip", ip, {
    limit: SIGNUP_LIMIT,
    windowSec: SIGNUP_WINDOW_SEC,
  });
  if (!limit.ok) {
    return { ok: false, code: "RATE_LIMITED" };
  }

  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    storeName: formData.get("storeName"),
    storeHandle: formData.get("storeHandle"),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first.path[0] as SignupField | undefined;
    return { ok: false, code: signupCodeForField(field), field };
  }

  const { email, password, storeName, storeHandle } = parsed.data;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return { ok: false, code: "EMAIL_TAKEN", field: "email" };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // The owner-supplied handle is the slug. If it's already taken we reject
  // outright — better than silently appending a random suffix that breaks
  // the staff login URL the owner just promised their cashier.
  const slug = storeHandle.toLowerCase();
  const [slugClash] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (slugClash) {
    return { ok: false, code: "HANDLE_TAKEN", field: "storeHandle" };
  }

  const locale = await activeLocale();
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, name: null, locale })
      .returning({ id: users.id });

    const [tenant] = await tx
      .insert(tenants)
      .values({ name: storeName, slug })
      .returning({ id: tenants.id });

    // RLS guard: every tenant-scoped insert below this point needs
    // `app.tenant_id` set in the session — otherwise the NULLIF policy
    // returns NULL and Postgres rejects the row. `branches` was added
    // to the RLS-forced set in migration 0014, so the set_config must
    // run BEFORE the branches insert (this used to live further down
    // and broke signup once branches RLS was enabled).
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);

    // Every new tenant gets a primary branch — multi-store: this is the
    // first "store" they own under their billing account. Owner sees all
    // branches, branch_id stays NULL on the membership row.
    const [primaryBranch] = await tx
      .insert(branches)
      .values({
        tenantId: tenant.id,
        slug: "main",
        name: storeName,
        isPrimary: true,
        isActive: true,
      })
      .returning({ id: branches.id });

    await tx.insert(tenantMembers).values({
      tenantId: tenant.id,
      userId: user.id,
      role: "owner",
    });

    await tx.insert(shopSettings).values({
      tenantId: tenant.id,
      branchId: primaryBranch.id,
      shopName: "",
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
    });
  });

  // Start the trial. ensureSubscription is idempotent so this is safe
  // to call again from the middleware as a fallback for legacy tenants.
  // Do this before sign-in so the very first authenticated request already
  // sees an active subscription row.
  // We need the tenant id we just created — re-fetch by slug.
  try {
    const [t] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (t) await ensureSubscription(t.id);
  } catch (err) {
    console.warn("[signup] ensureSubscription failed (non-fatal):", err);
  }

  // Auto sign-in after signup. If this fails the tenant is already created
  // — we surface AUTO_LOGIN_FAILED so the client can show "Account ready,
  // please log in" instead of pretending everything's fine and dropping the
  // user on /onboarding with no session (which then bounces to /login with
  // no explanation).
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
          shopPhone: parsed.data.shopPhone || null,
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
  await signOut({ redirect: false });
  redirect("/login");
}
