import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/lib/auth.config";
import { LOCALE_COOKIE, defaultLocale, isLocale, locales } from "@/lib/i18n/config";
import { detectLocale, pathLocale } from "@/lib/i18n/detect";
import {
  gateAdminRequest,
  hasAdminCookie,
  hardNotFound,
  isAdminPublicPath,
} from "@/lib/admin/middleware";

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
  // attendance check-in uses geolocation, and the barcode scanner
  // (components/scanner/BarcodeScannerModal.tsx — reached from inventory,
  // product search, add-product step 3, and edit-product) calls getUserMedia,
  // so camera must be allowed on self. `camera=()` is an empty allowlist that
  // denies even same-origin, which disables scanning on the real HTTPS domain
  // while looking fine over plain-HTTP localhost. Microphone stays denied.
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(self)",
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

// True iff the request is a top-level HTML navigation (i.e. user typed an
// address, hit refresh, or followed an external link) — not an RSC partial
// fetch from a client-side <Link>, not an asset request, not an API call.
// Used by the demo-store reset hook so client-side router navigation keeps
// the visitor's edits alive while a hard refresh wipes them.
function isFullPageHtmlNav(req: NextRequest, pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  // Next.js client-side router fetch — carries this header, full-page loads do not.
  if (req.headers.get("rsc") || req.headers.get("next-router-state-tree")) {
    return false;
  }
  // Server Actions POSTs carry this header — they're not navigations.
  if (req.headers.get("next-action")) return false;
  const fetchMode = req.headers.get("sec-fetch-mode");
  // sec-fetch-mode is "navigate" only for top-level document loads. When the
  // header is absent (older browsers / non-standard clients) fall back to
  // checking that the Accept header asks for HTML.
  if (fetchMode && fetchMode !== "navigate") return false;
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html") || fetchMode === "navigate";
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
  // Live availability checks hit from the unauthed signup form (step 1
  // and step 2 of the wizard). Both surface "taken vs free" without
  // leaking anything beyond what signupAction already returns.
  "/api/account/store-handle/check",
  "/api/account/email/check",
  // Password reset endpoints — they don't need an active session.
  "/api/account/password/forgot",
  "/api/account/password/reset",
  // Lightweight token validation the reset page calls on mount so the
  // user finds out about an expired link without filling the form first.
  "/api/account/password/reset/validate",
  // Spec 04 — public plan catalogue read for the landing page + /billing.
  // No auth; cached at the edge for 60s; falls back to a typed catalogue
  // on DB error so the pricing surface never blanks out.
  "/api/plans",
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
  // Platform-admin Spec 03 — the suspended-tenant landing. Public so a
  // signed-in user whose tenant just got paused can read the message
  // (their session may be revoked before this redirect fires).
  "/service-paused",
]);
const PUBLIC_PREFIXES = [
  "/api/auth",
  // Native sign-in / refresh: these MINT a session, so they cannot require one.
  "/api/v1/auth",
  // Cron sweeps run from a sidecar with no session — they're guarded by
  // a shared-secret bearer token inside the route handler instead.
  "/api/cron",
  // OS association files for Universal Links / App Links
  // (apple-app-site-association, assetlinks.json). Apple's CDN and Android's
  // verifier fetch these anonymously and follow no redirects, so they must
  // never hit the session check. Routes live in app/.well-known/.
  "/.well-known",
  "/_next",
  "/favicon",
  "/fonts",
];

// Onboarding gating: enforced below. The jwt callback in lib/auth.ts re-reads
// onboardingComplete from the DB on every navigation (the cache is busted by
// completeOnboardingAction → bustUserContextCache), so the next request after
// the wizard finishes carries the fresh claim and the user proceeds without a
// loop. The previous incarnation of this middleware deliberately skipped this
// gate; users could then type any URL after signup and slip past onboarding.
export default auth((req) => {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  // Platform-admin gate. Runs FIRST so /admin/* never touches tenant auth.
  // Hard-404 to invisible non-admins (spec §2.5); /admin/login is the only
  // public surface; everything else needs the admin cookie.
  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/")) {
    const blocked = gateAdminRequest(req);
    if (blocked) return blocked;
    if (!isAdminPublicPath(pathname) && !hasAdminCookie(req)) {
      return hardNotFound();
    }
    // Authenticated admin (or public admin path) — let the route run.
    return NextResponse.next();
  }

  // Generate a fresh nonce for every request and propagate it forward via
  // the modified request headers so server components can read it.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  // Request id: prefer an upstream-supplied one (load balancer / proxy)
  // so distributed traces match. Otherwise mint a fresh uuid. Propagated
  // forward via the modified request headers so route handlers can read
  // it via `headers()`, and stamped on the response so a client ticket
  // can be cross-referenced with server logs.
  const incomingReqId = req.headers.get("x-request-id");
  const requestId =
    incomingReqId && /^[A-Za-z0-9._\-:]{1,128}$/.test(incomingReqId)
      ? incomingReqId
      : crypto.randomUUID();
  requestHeaders.set("x-request-id", requestId);

  // Locale resolution for the `x-locale` header that the root layout reads:
  //  1. If the URL has /ar/ or /en/, that wins (pre-login surface).
  //  2. Otherwise prefer the user's saved preference from the JWT (the
  //     logged-in app uses unprefixed URLs per i18n-app-phase2.md §3.1).
  //  3. Otherwise the cookie (returning visitor on a public route).
  //  4. Otherwise defaultLocale.
  const sessionLocale =
    req.auth?.user?.locale === "ar" || req.auth?.user?.locale === "en"
      ? req.auth.user.locale
      : null;
  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  const cookieFallback =
    cookieLocale === "ar" || cookieLocale === "en" ? cookieLocale : null;
  const localeInPath = pathLocale(pathname);
  const activeLocale =
    localeInPath ?? sessionLocale ?? cookieFallback ?? defaultLocale;
  requestHeaders.set("x-locale", activeLocale);

  const passThrough = () => {
    const res = applyCsp(
      req,
      nonce,
      NextResponse.next({ request: { headers: requestHeaders } }),
    );
    res.headers.set("x-request-id", requestId);
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

  // A native client authenticates with `Authorization: Bearer`, not a cookie,
  // so `req.auth` is empty for every one of its requests. Without this bypass
  // the middleware would 401 them all here — before any route handler runs —
  // and the bearer support in lib/api/auth-helpers.ts would be unreachable.
  //
  // This is NOT a hole: the request is simply allowed to proceed to its
  // handler, where `requireTenant()` verifies the token's signature, issuer,
  // audience and expiry and returns the same 401 if it is not valid. The edge
  // stops guessing; the handler still decides.
  //
  // Scoped to /api/* on purpose. A page navigation has no bearer token, so
  // letting one through would render an authenticated shell to an anonymous
  // visitor.
  const hasBearer =
    pathname.startsWith("/api/") &&
    /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "");

  if (!session?.user && !hasBearer) {
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
    // Preserve query string + hash so e.g. /reports?from=yesterday → after
    // login the user is dropped back on /reports?from=yesterday, not /reports.
    loginUrl.searchParams.set("next", pathname + (nextUrl.search ?? ""));
    return applyCsp(req, nonce, NextResponse.redirect(loginUrl));
  }

  // Bearer request with no cookie session. Every gate below this point reads
  // `session.user.*`, which does not exist here — so they are all deferred to
  // `requireTenant()` in lib/api/auth-helpers.ts, which enforces the identical
  // three checks from the token's own claims and returns the identical bodies:
  //
  //   403 TENANT_SUSPENDED · 403 PASSWORD_CHANGE_REQUIRED · 402 SUBSCRIPTION_REQUIRED
  //
  // The edge cannot do it itself: verifying these tokens needs node:crypto,
  // which the edge runtime does not provide. Letting the request through is
  // therefore not a bypass — it moves the decision one layer in, to the only
  // place that can actually make it.
  if (!session?.user) {
    return passThrough();
  }

  // Spec 03 — tenant suspension. When the JWT carries a non-null
  // tenantSuspendedAt, every authenticated request gets bounced to
  // /service-paused. Sign-out + the suspended page itself stay reachable
  // so a stuck owner can sign out and contact support.
  if (
    session.user.tenantSuspendedAt &&
    pathname !== "/service-paused" &&
    !pathname.startsWith("/api/auth/")
  ) {
    if (pathname.startsWith("/api/")) {
      return applyCsp(
        req,
        nonce,
        NextResponse.json({ error: "TENANT_SUSPENDED" }, { status: 403 }),
      );
    }
    const url = new URL("/service-paused", nextUrl);
    return applyCsp(req, nonce, NextResponse.redirect(url));
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

  // Soft onboarding gate (Stripe / Shopify pattern). Users with
  // onboardingComplete=false can roam the app freely; the persistent
  // <OnboardingReminder /> banner rendered inside AppShell nudges them
  // back to /onboarding. Previously this block hard-redirected every
  // navigation to /onboarding, which felt like a trap. The banner is the
  // industry-standard substitute — visible on every page, dismissible per
  // session, but un-dismissible permanently until the wizard finishes.
  //
  // Intentionally left empty so the request falls through to the next
  // (subscription) gate.

  // Demo store reset hook. Middleware runs on the Edge runtime where
  // postgres + node:crypto aren't available, so we can't actually do the
  // DB work here — we just tag the request with a header. The root layout
  // (Node runtime) reads the header and calls resetDemoClone() before
  // rendering. Client-side router fetches and asset requests don't get
  // tagged, so navigating via <Link> keeps the visitor's state alive.
  if (
    session.user.isDemo &&
    session.user.tenantId &&
    session.user.id &&
    isFullPageHtmlNav(req, pathname)
  ) {
    requestHeaders.set("x-demo-reset", "1");
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
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|ttf|woff|woff2|wav|mp3|ogg|webp|gif)$).*)"],
};
