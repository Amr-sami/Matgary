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
import { logActivity } from "./repo/activity";
import { cacheBustPrefix, cacheRemember, globalKey } from "./cache";
import { rateLimit, rateLimitConsume } from "./ratelimit";

// Login limits — both must pass. The IP guard slows credential-stuffing from
// a single host; the email guard slows targeted attacks. Numbers are tight
// enough to bite a real attacker but loose enough that a frustrated user
// fat-fingering on their phone never sees a wall.
const LOGIN_IP_LIMIT = 10;
const LOGIN_IP_WINDOW_SEC = 15 * 60;
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_EMAIL_WINDOW_SEC = 15 * 60;

function clientIpFromRequest(req: Request | undefined): string {
  if (!req) return "unknown";
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

// 60s: short enough that a permission change is felt almost immediately,
// long enough to absorb the per-request hammer the JWT callback creates on
// any active session. Mutations that change membership/permissions/onboarding
// MUST call bustUserContextCache(userId) so the next request re-reads.
const USER_CONTEXT_TTL_SEC = 60;
const userContextKey = (userId: string) =>
  globalKey("userctx", userId);

/** Drop the cached membership/perm bundle for a user. Call from any mutation
 *  that changes role, permission grants, tenant membership, or onboarding. */
export async function bustUserContextCache(userId: string): Promise<void> {
  await cacheBustPrefix(userContextKey(userId));
}

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
      /** Whether the tenant's subscription currently grants access to the app. */
      subscriptionAccessActive: boolean;
      subscriptionStatus: string | null;
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
    subscriptionAccessActive: boolean;
    subscriptionStatus: string | null;
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

interface UserContext {
  tenantId: string | null;
  tenantSlug: string | null;
  role: string | null;
  permissions: Permission[];
  onboardingComplete: boolean;
  mustChangePassword: boolean;
  subscriptionAccessActive: boolean;
  subscriptionStatus: string | null;
}

async function resolveTenantContext(userId: string): Promise<UserContext> {
  // Cache the resolved context for ~1 min. The JWT callback runs on every
  // page load, so without this we hit 4 tables per request. Callers that
  // mutate any of these fields invoke bustUserContextCache(userId).
  return cacheRemember(userContextKey(userId), USER_CONTEXT_TTL_SEC, async () => {
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

    // Subscription state. We compute this here (inside the same cached
    // resolution) so the JWT token + middleware see a single consistent view.
    let subscriptionAccessActive = true;
    let subscriptionStatus: string | null = null;
    if (tenantId) {
      try {
        const sub = await ensureSubscriptionInline(tenantId);
        subscriptionAccessActive = sub.isAccessActive;
        subscriptionStatus = sub.status;
      } catch (err) {
        // If the lookup fails, default to "access active" so an outage of the
        // subscription store doesn't lock everyone out.
        console.warn("[auth] subscription resolve failed:", err);
      }
    }

    return {
      tenantId,
      tenantSlug,
      role,
      permissions,
      onboardingComplete,
      mustChangePassword,
      subscriptionAccessActive,
      subscriptionStatus,
    };
  });
}

// Defer-imported wrapper — we can't `import { ensureSubscription }` at the
// top because lib/repo/subscriptions imports lib/db (Node-only) AND lib/auth
// is imported by both server and edge entry points; the actual subscription
// fetch only ever runs on Node so a runtime require keeps the edge bundle
// from pulling postgres-js. (Both files end up in Node in practice today,
// but this guards against a future edge-runtime migration.)
async function ensureSubscriptionInline(tenantId: string) {
  const mod = await import("./repo/subscriptions");
  return mod.ensureSubscription(tenantId);
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
      authorize: async (raw, req) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const ip = clientIpFromRequest(req as Request | undefined);
        const ipPeek = await rateLimit("login.ip", ip, {
          limit: LOGIN_IP_LIMIT,
          windowSec: LOGIN_IP_WINDOW_SEC,
          commit: false,
        });
        const emailPeek = await rateLimit("login.email", parsed.data.email, {
          limit: LOGIN_EMAIL_LIMIT,
          windowSec: LOGIN_EMAIL_WINDOW_SEC,
          commit: false,
        });
        if (!ipPeek.ok || !emailPeek.ok) {
          // Returning null surfaces as CredentialsSignin to the client. We
          // intentionally don't tell the user they're rate-limited — that
          // would help an attacker tune their cadence.
          return null;
        }

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, parsed.data.email))
          .limit(1);

        const matched = !!(user && user.passwordHash);
        const ok =
          matched
            ? await bcrypt.compare(parsed.data.password, user!.passwordHash!)
            : false;

        if (!ok) {
          await Promise.all([
            rateLimitConsume("login.ip", ip, {
              limit: LOGIN_IP_LIMIT,
              windowSec: LOGIN_IP_WINDOW_SEC,
            }),
            rateLimitConsume("login.email", parsed.data.email, {
              limit: LOGIN_EMAIL_LIMIT,
              windowSec: LOGIN_EMAIL_WINDOW_SEC,
            }),
          ]);
          return null;
        }

        return {
          id: user!.id,
          email: user!.email,
          name: user!.name,
          image: user!.image,
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
        token.subscriptionAccessActive = ctx.subscriptionAccessActive;
        token.subscriptionStatus = ctx.subscriptionStatus;
        if (ctx.tenantId) {
          logActivity({
            tenantId: ctx.tenantId,
            actorUserId: user.id!,
            actorName: user.name ?? user.email ?? null,
            action: "auth.login",
            category: "auth",
            entityType: "user",
            entityId: user.id!,
          });
        }
      } else if ((trigger === "update" || token.id) && typeof token.id === "string") {
        const ctx = await resolveTenantContext(token.id);
        token.tenantId = ctx.tenantId;
        token.tenantSlug = ctx.tenantSlug;
        token.role = ctx.role;
        token.permissions = ctx.permissions;
        token.onboardingComplete = ctx.onboardingComplete;
        token.mustChangePassword = ctx.mustChangePassword;
        token.subscriptionAccessActive = ctx.subscriptionAccessActive;
        token.subscriptionStatus = ctx.subscriptionStatus;
      }
      return token;
    },
  },
});
