import type { Metadata } from "next";
import { headers, cookies } from "next/headers";
import { Cairo, Tajawal, Lemonada } from "next/font/google";
import Script from "next/script";
import { SessionProvider } from "next-auth/react";
import { IconProvider } from "@/components/IconProvider";
import { defaultLocale, dirOf, isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { DictionaryProvider } from "@/components/i18n/DictionaryProvider";
import { ActiveBranchNameProvider } from "@/components/layout/ActiveBranchProvider";
import { BRANCH_NAME_COOKIE } from "@/lib/api/branch-name-cookie";
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
  title: "Matjary - نظام إدارة المخزن والمبيعات",
  description: "نظام نقطة البيع وإدارة المخزن لمتجرك الساعات والبرفانات والنظارات",
};

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
  // Phase 2 — load the dictionary at the root so the entire app (logged-in
  // pages + the pre-login [lang] tree) sees it via React context.
  // Pre-login pages still nest their own DictionaryProvider with the
  // URL-derived locale; the nested provider wins (React context shadow),
  // so this root one is the fallback for any page outside [lang].
  const dict = await getDictionary(locale);
  // Active branch name from the non-HttpOnly companion cookie. Lets the
  // Sidebar render the right store heading on the SSR HTML — no
  // "متجري → elhenawystore → Main" cascade on hard refresh. Null when
  // the cookie isn't set yet (first ever load); falls back to the
  // locale's storeFallback until `/api/branches` populates the cookie.
  const cookieStore = await cookies();
  const activeBranchName =
    cookieStore.get(BRANCH_NAME_COOKIE)?.value ?? null;
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
            <span className="app-splash__ar" dir="rtl">متجري</span>
            <span className="app-splash__en" dir="ltr">MATJARI</span>
          </div>
        </div>
        {/* React 19 refuses to execute inline <script> tags rendered as JSX
            children (silent fail + console warning). next/script with
            `beforeInteractive` injects the script tag outside React's
            tree, which both makes the browser execute it AND lets us run
            very early (before hydration starts), so the splash-hide
            timer is already armed when window.load fires. */}
        <Script
          id="app-splash-hide"
          strategy="beforeInteractive"
        >{`(function(){var start=Date.now();function hide(){var elapsed=Date.now()-start;var wait=Math.max(0,520-elapsed);setTimeout(function(){var el=document.getElementById('app-splash');if(el)el.classList.add('app-splash--hidden');},wait);}if(document.readyState==='complete')hide();else window.addEventListener('load',hide,{once:true});})();`}</Script>
        <SessionProvider>
          <IconProvider>
            <DictionaryProvider locale={locale} dict={dict}>
              <ActiveBranchNameProvider initialName={activeBranchName}>
                {children}
              </ActiveBranchNameProvider>
            </DictionaryProvider>
          </IconProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
