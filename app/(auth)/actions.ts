"use server";

import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { redirect } from "next/navigation";
import { db, withTenant } from "@/lib/db";
import {
  users,
  tenants,
  tenantMembers,
  shopSettings,
} from "@/lib/db/schema";
import { signIn, signOut, auth } from "@/lib/auth";
import { slugify } from "@/lib/utils/slug";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

const signupSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8, "كلمة المرور 8 أحرف على الأقل").max(128),
  storeName: z.string().min(1, "اسم المتجر مطلوب").max(80),
});

export type SignupResult =
  | { ok: true }
  | { ok: false; error: string; field?: "email" | "password" | "storeName" };

export async function signupAction(formData: FormData): Promise<SignupResult> {
  const parsed = signupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    storeName: formData.get("storeName"),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first.message,
      field: first.path[0] as "email" | "password" | "storeName" | undefined,
    };
  }

  const { email, password, storeName } = parsed.data;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return { ok: false, error: "هذا البريد مسجّل بالفعل", field: "email" };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Pick a unique slug; retry a few times on collision.
  let slug = slugify(storeName);
  for (let i = 0; i < 5; i++) {
    const [clash] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!clash) break;
    slug = `${slugify(storeName)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, name: null })
      .returning({ id: users.id });

    const [tenant] = await tx
      .insert(tenants)
      .values({ name: storeName, slug })
      .returning({ id: tenants.id });

    await tx.insert(tenantMembers).values({
      tenantId: tenant.id,
      userId: user.id,
      role: "owner",
    });

    // shop_settings is RLS-protected — set app.tenant_id for the rest of the tx
    // before inserting an empty placeholder row that onboarding will fill.
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
    await tx.insert(shopSettings).values({
      tenantId: tenant.id,
      shopName: "",
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
    });
  });

  // Auto sign-in after signup.
  await signIn("credentials", {
    email,
    password,
    redirect: false,
  });

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
  shopName: z.string().min(1, "اسم المتجر مطلوب").max(80),
  shopPhone: z.string().max(40).optional().or(z.literal("")),
  preset: z.enum(["cornerstore", "blank"]),
});

export type OnboardingResult = { ok: true } | { ok: false; error: string };

export async function completeOnboardingAction(
  formData: FormData,
): Promise<OnboardingResult> {
  const session = await auth();
  if (!session?.user?.tenantId) {
    return { ok: false, error: "غير مسجّل الدخول" };
  }

  const parsed = onboardingSchema.safeParse({
    shopName: formData.get("shopName"),
    shopPhone: formData.get("shopPhone") ?? "",
    preset: formData.get("preset"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }

  const tenantId = session.user.tenantId;

  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(shopSettings)
        .set({
          shopName: parsed.data.shopName,
          shopPhone: parsed.data.shopPhone || null,
          onboardingCompletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(shopSettings.tenantId, tenantId));

      if (parsed.data.preset === "cornerstore") {
        await seedCornerStorePreset(tx, tenantId);
      }
    });
  } catch (err) {
    console.error("[onboarding] failed", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "تعذر إكمال الإعداد",
    };
  }

  return { ok: true };
}

export async function logoutAction() {
  await signOut({ redirect: false });
  redirect("/login");
}
