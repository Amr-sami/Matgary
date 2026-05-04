import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, withTenant } from "./db";
import { users, tenantMembers, shopSettings, tenants } from "./db/schema";
import { authConfig } from "./auth.config";
import type { Permission } from "./permissions";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      tenantId: string | null;
      tenantSlug: string | null;
      onboardingComplete: boolean;
      role: string | null;
      permissions: Permission[];
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    tenantId: string | null;
    tenantSlug: string | null;
    onboardingComplete: boolean;
    role: string | null;
    permissions: Permission[];
    mustChangePassword: boolean;
  }
}

// Strip invisible characters that mobile keyboards and RTL copy/paste love to
// insert — leading spaces, zero-width-space, RLM/LRM marks, BOM. These silently
// turn a correct-looking identifier into a different string.
function normalizeIdentifier(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‏‪-‮﻿]/g, "")
    .trim()
    .toLowerCase();
}

// Accept either a real email OR a synthetic sub-account identifier like
// "username@tenant-slug" (no TLD required).
const credentialsSchema = z.object({
  email: z
    .string()
    .min(3)
    .max(200)
    .transform(normalizeIdentifier)
    .pipe(
      z.string().regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+$/i, "Invalid login identifier"),
    ),
  password: z.string().min(8).max(128),
});

async function resolveTenantContext(userId: string) {
  // tenant_members + users are NOT RLS-protected so this works against the
  // plain client without setting app.tenant_id.
  const [membership] = await db
    .select({
      tenantId: tenantMembers.tenantId,
      role: tenantMembers.role,
      permissions: tenantMembers.permissions,
    })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1);

  const [user] = await db
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const tenantId = membership?.tenantId ?? null;
  const role = membership?.role ?? null;
  const permissions = (membership?.permissions ?? []) as Permission[];
  const mustChangePassword = !!user?.mustChangePassword;

  let onboardingComplete = false;
  let tenantSlug: string | null = null;

  if (tenantId) {
    const [tenant] = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    tenantSlug = tenant?.slug ?? null;

    // shop_settings IS RLS-protected — set app.tenant_id first.
    const settings = await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ shopName: shopSettings.shopName })
        .from(shopSettings)
        .where(eq(shopSettings.tenantId, tenantId))
        .limit(1);
      return row;
    });
    onboardingComplete = !!settings?.shopName;
  }

  return {
    tenantId,
    tenantSlug,
    role,
    permissions,
    onboardingComplete,
    mustChangePassword,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db),
  providers: [
    Credentials({
      name: "Email + Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, parsed.data.email))
          .limit(1);

        if (!user || !user.passwordHash) return null;

        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt: async ({ token, user, trigger }) => {
      if (user) {
        token.id = user.id!;
        const ctx = await resolveTenantContext(user.id!);
        token.tenantId = ctx.tenantId;
        token.tenantSlug = ctx.tenantSlug;
        token.role = ctx.role;
        token.permissions = ctx.permissions;
        token.onboardingComplete = ctx.onboardingComplete;
        token.mustChangePassword = ctx.mustChangePassword;
      } else if ((trigger === "update" || token.id) && typeof token.id === "string") {
        const ctx = await resolveTenantContext(token.id);
        token.tenantId = ctx.tenantId;
        token.tenantSlug = ctx.tenantSlug;
        token.role = ctx.role;
        token.permissions = ctx.permissions;
        token.onboardingComplete = ctx.onboardingComplete;
        token.mustChangePassword = ctx.mustChangePassword;
      }
      return token;
    },
  },
});
