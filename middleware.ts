import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = new Set<string>(["/login", "/signup"]);
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
    const loginUrl = new URL("/login", nextUrl);
    if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|ttf|woff|woff2)$).*)"],
};
