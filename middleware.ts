import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/welcome",
  // Marketing pages — linked from the public footer, no auth needed.
  "/about",
  "/contact",
  "/blog",
  "/help",
  "/status",
  "/terms",
  "/privacy",
  // Live slug availability check is hit from the unauthed signup form.
  "/api/account/store-handle/check",
  // Password reset endpoints — they don't need an active session.
  "/api/account/password/forgot",
  "/api/account/password/reset",
  // Visual preview of error/empty screens — handy on a phone, no auth needed.
  "/preview/errors",
]);
const PUBLIC_PREFIXES = [
  "/api/auth",
  // Cron sweeps run from a sidecar with no session — they're guarded by
  // a shared-secret bearer token inside the route handler instead.
  "/api/cron",
  "/_next",
  "/favicon",
  "/fonts",
];

// NOTE on onboarding gating: middleware runs in the Edge runtime and reads the
// JWT cookie directly — it does NOT re-run the jwt callback that hits the DB,
// so onboardingComplete in the cookie can be stale right after a user finishes
// onboarding. Gating on it here causes a redirect loop. Onboarding is enforced
// instead by the signup action (always sends new users to /onboarding) and the
// onboarding page checks server-side via auth() if needed.
export default auth((req) => {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  if (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  const session = req.auth;

  if (!session?.user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Anonymous "/" → marketing landing, not the login wall.
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/welcome", nextUrl));
    }
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Force users with mustChangePassword=true through the change-password page
  // before they can do anything else. The change-password endpoint and the
  // signout API are explicitly allowed so they can complete the flow.
  if (
    session.user.mustChangePassword &&
    pathname !== "/account/change-password" &&
    !pathname.startsWith("/api/account/password") &&
    !pathname.startsWith("/api/auth/")
  ) {
    if (pathname.startsWith("/api/")) {
      // API consumers can't follow an HTML redirect — give them a 403 with a
      // hint so the client can route the user to the change-password page.
      return NextResponse.json(
        { error: "PASSWORD_CHANGE_REQUIRED" },
        { status: 403 },
      );
    }
    return NextResponse.redirect(new URL("/account/change-password", nextUrl));
  }

  // Subscription gate. When the trial has expired without a paid subscription
  // (or an active subscription has lapsed past its grace period) every
  // non-billing route redirects to /billing. Billing pages, the Paymob
  // webhook, and the change-password flow remain reachable so the owner
  // can recover.
  const allowedWhenSuspended =
    pathname === "/billing" ||
    pathname.startsWith("/api/billing/") ||
    pathname === "/account/change-password" ||
    pathname.startsWith("/api/account/password");
  if (
    session.user.subscriptionAccessActive === false &&
    !allowedWhenSuspended
  ) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "SUBSCRIPTION_REQUIRED" },
        { status: 402 },
      );
    }
    return NextResponse.redirect(new URL("/billing", nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|ttf|woff|woff2)$).*)"],
};
