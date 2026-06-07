import type { Metadata } from "next";
import { headers } from "next/headers";
import { Cairo, Tajawal, Lemonada } from "next/font/google";
import { SessionProvider } from "next-auth/react";
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
  title: "CornerStore - نظام إدارة المخزن والمبيعات",
  description: "نظام نقطة البيع وإدارة المخزن لمتجر الساعات والبرفانات والنظارات",
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
  return (
    <html lang={locale} dir={dir} className={`${cairo.variable} ${tajawal.variable} ${lemonada.variable}`}>
      <body className="min-h-screen flex flex-col antialiased">
        <SessionProvider>
          <IconProvider>
            <DictionaryProvider locale={locale} dict={dict}>
              {children}
            </DictionaryProvider>
          </IconProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
