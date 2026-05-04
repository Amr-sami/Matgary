import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/signup",
  "/welcome",
  // Live slug availability check is hit from the unauthed signup form.
  "/api/account/store-handle/check",
  // Visual preview of error/empty screens — handy on a phone, no auth needed.
  "/preview/errors",
]);
const PUBLIC_PREFIXES = ["/api/auth", "/_next", "/favicon", "/fonts"];

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

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|ttf|woff|woff2)$).*)"],
};
