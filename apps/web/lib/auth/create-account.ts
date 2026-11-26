import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  users,
  tenants,
  tenantMembers,
  shopSettings,
  branches,
} from "@/lib/db/schema";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";
import { ensureSubscription } from "@/lib/repo/subscriptions";
import type { Locale } from "@/lib/i18n/config";

/**
 * Create an owner account and its store.
 *
 * Lifted out of the signupAction server action so a native client can reach
 * it. Everything the action did — validation, the uniqueness checks, the
 * user + tenant + primary branch + membership + shop settings transaction, and
 * the subscription bootstrap — is here, unchanged. The ONLY thing left behind
 * in the action is the final signIn(), because that is the one step the two
 * transports genuinely differ on: the web sets a cookie, native mints bearer
 * tokens. Neither gets a second copy of the account creation.
 */

export const signupSchema = z.object({
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

export type SignupInput = z.infer<typeof signupSchema>;

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

export type CreateAccountResult =
  | { ok: true; userId: string; email: string; tenantId: string }
  | { ok: false; code: SignupErrorCode; field?: SignupField };

// Map zod path → code so the per-field validation message is locale-agnostic.
export function signupCodeForField(field: SignupField | undefined): SignupErrorCode {
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

export async function createAccount(
  raw: unknown,
  locale: Locale,
): Promise<CreateAccountResult> {
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path[0] as SignupField | undefined;
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

  const slug = storeHandle.toLowerCase();
  const [slugClash] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (slugClash) {
    return { ok: false, code: "HANDLE_TAKEN", field: "storeHandle" };
  }

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash, name: null, locale })
      .returning({ id: users.id });

    const [tenant] = await tx
      .insert(tenants)
      .values({ name: storeName, slug })
      .returning({ id: tenants.id });

    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);

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

    return { userId: user.id, tenantId: tenant.id };
  });

  try {
    await ensureSubscription(created.tenantId);
  } catch (err) {
    console.warn("[signup] ensureSubscription failed (non-fatal):", err);
  }

  return { ok: true, userId: created.userId, email, tenantId: created.tenantId };
}
