import type { NextAuthConfig } from "next-auth";
import type { Permission } from "./permissions";

// Edge-safe Auth.js config — used by middleware. Does NOT import the database
// or argon2 (both incompatible with Edge runtime). The full config in
// lib/auth.ts extends this with the Credentials provider for the Node runtime.
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  providers: [], // populated in lib/auth.ts
  trustHost: true,
  callbacks: {
    // Edge-safe — only reads the JWT, no DB calls.
    session: ({ session, token }) => {
      // H09 — JWT callback clears `id` on token_version mismatch. Drop the
      // session entirely so middleware redirects to /login.
      if (token && (!token.id || token.id === "")) {
        return null as unknown as typeof session;
      }
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.tenantId = (token.tenantId as string | null) ?? null;
        session.user.tenantSlug = (token.tenantSlug as string | null) ?? null;
        session.user.onboardingComplete = !!token.onboardingComplete;
        session.user.role = (token.role as string | null) ?? null;
        session.user.permissions = (token.permissions as Permission[] | undefined) ?? [];
        session.user.mustChangePassword = !!token.mustChangePassword;
        session.user.subscriptionAccessActive =
          token.subscriptionAccessActive == null
            ? true // tolerate older tokens — treat missing claim as "allow"
            : !!token.subscriptionAccessActive;
        session.user.subscriptionStatus =
          (token.subscriptionStatus as string | null) ?? null;
        // Phase 2 — locale claim. Older tokens (issued before this column
        // existed) fall through to 'ar' to keep existing behaviour.
        session.user.locale = (token.locale === "en" ? "en" : "ar") as
          | "ar"
          | "en";
        // Spec 03 — tenant suspended fields. Older tokens fall through
        // to null (treated as not suspended).
        session.user.tenantSuspendedAt =
          (token.tenantSuspendedAt as string | null) ?? null;
        session.user.tenantSuspendedReason =
          (token.tenantSuspendedReason as string | null) ?? null;
        // Spec 07 — impersonation context. The hard cap is enforced here:
        // any token whose claim says it's past the cap is treated as
        // logged-out so AppShell + middleware bounce the request.
        const impExpires = token.impersonationExpiresAt as number | undefined;
        if (
          token.impersonationAdminId &&
          impExpires &&
          Date.now() < impExpires
        ) {
          session.impersonation = {
            adminId: token.impersonationAdminId as string,
            adminEmail: token.impersonationAdminEmail as string,
            sessionId: token.impersonationSessionId as string,
            startedAt: token.impersonationStartedAt as number,
            expiresAt: impExpires,
          };
        } else if (token.impersonationAdminId) {
          // Past the cap → return null to fully invalidate the session.
          return null as unknown as typeof session;
        }
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
