import type { Metadata } from "next";
import { headers } from "next/headers";
import { Cairo, Tajawal, Lemonada } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { IconProvider } from "@/components/IconProvider";
import { defaultLocale, dirOf, isLocale } from "@/lib/i18n/config";
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
  // Middleware writes x-locale on every request based on the URL path
  // (`/ar/*` → ar, `/en/*` → en, anything else → defaultLocale).
  const hdrs = await headers();
  const raw = hdrs.get("x-locale");
  const locale = raw && isLocale(raw) ? raw : defaultLocale;
  const dir = dirOf(locale);
  return (
    <html lang={locale} dir={dir} className={`${cairo.variable} ${tajawal.variable} ${lemonada.variable}`}>
      <body className="min-h-screen flex flex-col antialiased">
        <SessionProvider>
          <IconProvider>{children}</IconProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
