import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, withTenant } from "./db";
import { users, tenantMembers, shopSettings } from "./db/schema";
import { authConfig } from "./auth.config";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      tenantId: string | null;
      onboardingComplete: boolean;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    tenantId: string | null;
    onboardingComplete: boolean;
  }
}

const credentialsSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
});

async function resolveTenantContext(userId: string) {
  // tenant_members is NOT RLS-protected (it's a global table) so this lookup
  // works against the plain client.
  const [membership] = await db
    .select({ tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1);

  const tenantId = membership?.tenantId ?? null;
  let onboardingComplete = false;

  if (tenantId) {
    // shop_settings IS RLS-protected — we have to set app.tenant_id before
    // the query or the row is invisible. Without this, onboardingComplete
    // stays false forever even after the user finishes onboarding, which
    // creates a redirect loop the moment we re-introduce the gate.
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

  return { tenantId, onboardingComplete };
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
      // On sign-in, `user` is populated with the result of `authorize`.
      // On every other request, only `token` is present.
      if (user) {
        token.id = user.id!;
        const ctx = await resolveTenantContext(user.id!);
        token.tenantId = ctx.tenantId;
        token.onboardingComplete = ctx.onboardingComplete;
      } else if ((trigger === "update" || token.id) && typeof token.id === "string") {
        // Refresh tenant context on session.update() (e.g. after onboarding completes).
        const ctx = await resolveTenantContext(token.id);
        token.tenantId = ctx.tenantId;
        token.onboardingComplete = ctx.onboardingComplete;
      }
      return token;
    },
  },
});
