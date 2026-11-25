import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Cairo, Tajawal, Lemonada } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { IconProvider } from "@/components/IconProvider";
import { defaultLocale, dirOf, isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { DictionaryProvider } from "@/components/i18n/DictionaryProvider";
import "./globals.css";

const cairo = Cairo({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cairo",
  display: "swap",
});

// Display font for impressive headlines on the auth brand panel.
// Tajawal is a polished modern Arabic display family with multiple weights.
const tajawal = Tajawal({
  subsets: ["arabic", "latin"],
  weight: ["500", "700", "800", "900"],
  variable: "--font-display",
  display: "swap",
});

// Catchy / accent display font — soft rounded display, used for single
// emphasized words inside a Tajawal headline. Friendly + memorable.
const lemonada = Lemonada({
  subsets: ["arabic", "latin"],
  weight: ["500", "600", "700"],
  variable: "--font-catchy",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ستورو - نظام إدارة المخزن والمبيعات",
  description: "نظام نقطة البيع وإدارة المخزن لمتجرك الساعات والبرفانات والنظارات",
};

// Next 16 resolves the viewport meta tag from this separate export (NOT from
// `metadata`). `viewportFit: "cover"` is what makes iOS report real values for
// `env(safe-area-inset-*)`: without it every inset resolves to 0, so the
// bottom-inset rules in AppShell / MobileBottomNav / SkeletonShell never
// cleared the home indicator, and nothing cleared the notch / Dynamic Island.
// width + initialScale are Next's own defaults, restated so the meta tag stays
// identical apart from the added `viewport-fit=cover`.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Adds `.app-splash--hidden` after window.load, at least 520 ms after the
// script ran so the breathing animation is perceptible on fast loads.
const SPLASH_HIDE_JS = `(function(){var start=Date.now();function hide(){var elapsed=Date.now()-start;var wait=Math.max(0,520-elapsed);setTimeout(function(){var el=document.getElementById('app-splash');if(el)el.classList.add('app-splash--hidden');},wait);}if(document.readyState==='complete')hide();else window.addEventListener('load',hide,{once:true});})();`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Middleware writes x-locale on every request: URL path locale > session
  // user.locale > cookie > defaultLocale. Root layout reads from header
  // only — no auth() call here so we stay edge-fast.
  const hdrs = await headers();
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dir = dirOf(locale);
  // Middleware sets x-nonce per request. We pass it to the splash-hide
  // <script> explicitly: in dev we ship CSP as Report-Only, and Next.js's
  // auto-nonce injection only parses the enforce header.
  const nonce = hdrs.get("x-nonce") ?? undefined;
  // Phase 2 — load the dictionary at the root so the entire app (logged-in
  // pages + the pre-login [lang] tree) sees it via React context.
  // Pre-login pages still nest their own DictionaryProvider with the
  // URL-derived locale; the nested provider wins (React context shadow),
  // so this root one is the fallback for any page outside [lang].
  const dict = await getDictionary(locale);

  // Demo-store reset hook. Middleware (Edge runtime) flags the request with
  // x-demo-reset on every full-page navigation belonging to a demo session;
  // we do the actual DB wipe here in the root layout (Node runtime) so the
  // page renders against a freshly-cloned tenant. Wrapped in try/catch so a
  // DB hiccup can't take down every page render.
  if (hdrs.get("x-demo-reset") === "1") {
    try {
      const { auth } = await import("@/lib/auth");
      const session = await auth();
      if (session?.user?.isDemo && session.user.tenantId && session.user.id) {
        const { resetDemoClone } = await import("@/lib/demo/clone-tenant");
        await resetDemoClone({
          cloneId: session.user.tenantId,
          ownerUserId: session.user.id,
        });
      }
    } catch (err) {
      console.warn("[demo-reset] failed in root layout:", err);
    }
  }
  return (
    <html lang={locale} dir={dir} className={`${cairo.variable} ${tajawal.variable} ${lemonada.variable}`}>
      <body className="min-h-screen flex flex-col antialiased">
        {/* Splash — covers the viewport while the SSR HTML paints and
            React hydrates. Plain HTML + CSS so the browser shows it the
            instant the document arrives, before any JS runs. The inline
            script below adds `.app-splash--hidden` after window.load
            (with a minimum display time so the breathing animation is
            perceptible even on fast loads). We deliberately DO NOT
            removeChild the splash — it lives inside React's tree, so
            yanking it out from under React's reconciler causes
            NotFoundError on the next commit. visibility:hidden +
            pointer-events:none make it harmless to leave parked. */}
        <div id="app-splash" aria-hidden="true">
          {/* Brand wordmark inlined as plain HTML so it paints with the
              first byte of the document — no img download, no font swap
              latency relative to the rest of the page. Mirrors
              components/brand/Logo.tsx visually. */}
          <div className="app-splash__brand">
            <img
              src={locale === "en" ? "/thestorologoenglish.png" : "/storoarabic.png"}
              alt={locale === "en" ? "TheStoro" : "ذا ستورو"}
              className="app-splash__png"
            />
          </div>
        </div>
        {/* Splash-hide timer. A plain server-rendered <script> runs while the
            browser parses the HTML (before hydration, so the timer is armed
            when window.load fires). dangerouslySetInnerHTML, not JSX text:
            text children of a <script> are HTML-escaped by React's server
            renderer and the quotes would break the JS. React never runs a
            <script> it creates on the client, but the root layout is
            hydrated, not client-created, and the script already ran.
            suppressHydrationWarning (audit web W2): browsers hide a nonce
            attribute once the element is connected (getAttribute returns
            ""), so hydration saw nonce="" against the server's value and
            next dev showed a mismatch on every page. next/script does not
            forward the prop to its inner <script>, hence the plain tag. */}
        <script
          id="app-splash-hide"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: SPLASH_HIDE_JS }}
        />
        <SessionProvider>
          <QueryProvider>
            <IconProvider>
              <DictionaryProvider locale={locale} dict={dict}>
                {children}
              </DictionaryProvider>
            </IconProvider>
          </QueryProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
