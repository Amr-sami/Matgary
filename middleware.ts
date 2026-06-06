import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/lib/auth.config";
import { LOCALE_COOKIE, defaultLocale, isLocale, locales } from "@/lib/i18n/config";
import { detectLocale, pathLocale } from "@/lib/i18n/detect";

const { auth } = NextAuth(authConfig);

// Pre-login HTML routes that live under app/[lang]/*. Bare visits (e.g. /welcome)
// get redirected to /{locale}/welcome; visits already prefixed (/ar/..., /en/...)
// are normalized for the PUBLIC_PATHS check below.
const LOCALIZED_HTML_SLUGS = new Set<string>([
  "/welcome",
  "/about",
  "/contact",
  "/blog",
  "/help",
  "/status",
  "/terms",
  "/privacy",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/onboarding",
]);

function stripLocalePrefix(pathname: string): string {
  const seg = pathname.split("/")[1];
  if (seg && isLocale(seg)) {
    const rest = pathname.slice(seg.length + 1);
    return rest === "" ? "/" : rest;
  }
  return pathname;
}

// H08 — Content Security Policy. Per-request nonce so we don't have to ship
// 'unsafe-inline' for scripts. Report-Only by default until staging proves
// the policy clean; set CSP_ENFORCE=1 to flip to enforcement.
//
// `style-src` keeps `'unsafe-inline'` for v1 because Tailwind 4 injects
// runtime inline styles without a nonce hook today. Tracked in task.md §4
// backlog "Strict CSP for styles".
function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.sentry.io https://o*.ingest.sentry.io",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

const CSP_HEADER_NAME =
  process.env.CSP_ENFORCE === "1"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // attendance check-in uses geolocation — left allowed on self;
  // camera/microphone are not used by any current feature.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
};

function applyCsp(
  _req: NextRequest,
  nonce: string,
  response: NextResponse,
): NextResponse {
  response.headers.set(CSP_HEADER_NAME, buildCspHeader(nonce));
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(k)) response.headers.set(k, v);
  }
  return response;
}

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
  // Login form pre-checks whether a given email has 2FA enabled BEFORE the
  // password POST so the UI knows whether to ask for a TOTP code. No
  // password handled here; rate-limited per IP.
  "/api/auth/2fa-needed",
  // Visual preview of error/empty screens — handy on a phone, no auth needed.
  "/preview/errors",
  // Meta WhatsApp webhook — exact match so the /events admin sub-path
  // stays gated. Meta posts here without our session; the route enforces
  // its own X-Hub-Signature-256 + verify-token checks.
  "/api/whatsapp/webhook",
  // Health + readiness probes — must be reachable by orchestrator / nginx
  // upstream check without a session cookie. Both routes are no-tenant.
  "/healthz",
  "/readyz",
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

  // Generate a fresh nonce for every request and propagate it forward via
  // the modified request headers so server components can read it.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const localeInPath = pathLocale(pathname);
  const activeLocale = localeInPath ?? defaultLocale;
  requestHeaders.set("x-locale", activeLocale);

  const passThrough = () => {
    const res = applyCsp(
      req,
      nonce,
      NextResponse.next({ request: { headers: requestHeaders } }),
    );
    if (localeInPath) {
      const existing = req.cookies.get(LOCALE_COOKIE)?.value;
      if (existing !== localeInPath) {
        res.cookies.set(LOCALE_COOKIE, localeInPath, {
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
          sameSite: "lax",
        });
      }
    }
    return res;
  };

  // Bare pre-login slug → redirect to /{detected}/{slug}. Detection order:
  // cookie → Accept-Language → default (ar).
  if (
    !localeInPath &&
    (LOCALIZED_HTML_SLUGS.has(pathname) ||
      [...LOCALIZED_HTML_SLUGS].some(
        (slug) => slug !== "/" && pathname.startsWith(`${slug}/`),
      ))
  ) {
    const target = detectLocale(req);
    const url = new URL(`/${target}${pathname}${nextUrl.search}`, nextUrl);
    return applyCsp(req, nonce, NextResponse.redirect(url));
  }

  const normalizedPath = localeInPath ? stripLocalePrefix(pathname) : pathname;

  if (
    PUBLIC_PATHS.has(normalizedPath) ||
    PUBLIC_PREFIXES.some((p) => normalizedPath.startsWith(p))
  ) {
    return passThrough();
  }

  const session = req.auth;

  if (!session?.user) {
    if (pathname.startsWith("/api/")) {
      return applyCsp(req, nonce, NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    // Anonymous "/" → marketing landing in detected locale.
    if (pathname === "/") {
      return applyCsp(
        req,
        nonce,
        NextResponse.redirect(new URL(`/${activeLocale}/welcome`, nextUrl)),
      );
    }
    const loginUrl = new URL(`/${activeLocale}/login`, nextUrl);
    loginUrl.searchParams.set("next", pathname);
    return applyCsp(req, nonce, NextResponse.redirect(loginUrl));
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
      return applyCsp(
        req,
        nonce,
        NextResponse.json({ error: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 }),
      );
    }
    return applyCsp(
      req,
      nonce,
      NextResponse.redirect(new URL("/account/change-password", nextUrl)),
    );
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
      return applyCsp(
        req,
        nonce,
        NextResponse.json({ error: "SUBSCRIPTION_REQUIRED" }, { status: 402 }),
      );
    }
    return applyCsp(
      req,
      nonce,
      NextResponse.redirect(new URL("/billing", nextUrl)),
    );
  }

  return passThrough();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|ttf|woff|woff2)$).*)"],
};
