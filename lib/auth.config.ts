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
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.tenantId = (token.tenantId as string | null) ?? null;
        session.user.tenantSlug = (token.tenantSlug as string | null) ?? null;
        session.user.onboardingComplete = !!token.onboardingComplete;
        session.user.role = (token.role as string | null) ?? null;
        session.user.permissions = (token.permissions as Permission[] | undefined) ?? [];
        session.user.mustChangePassword = !!token.mustChangePassword;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
