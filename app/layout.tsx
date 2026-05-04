import type { Metadata } from "next";
import { Cairo, Tajawal, Lemonada } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import "./globals.css";

const cairo = Cairo({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cairo",
  display: "swap",
});

// Display font for impressive headlines on the auth brand panel.
// Tajawal is a polished modern Arabic display family with multiple weights.
const tajawal = Tajawal({
  subsets: ["arabic"],
  weight: ["500", "700", "800", "900"],
  variable: "--font-display",
  display: "swap",
});

// Catchy / accent display font — soft rounded display, used for single
// emphasized words inside a Tajawal headline. Friendly + memorable.
const lemonada = Lemonada({
  subsets: ["arabic"],
  weight: ["500", "600", "700"],
  variable: "--font-catchy",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CornerStore - نظام إدارة المخزن والمبيعات",
  description: "نظام نقطة البيع وإدارة المخزن لمتجر الساعات والبرفانات والنظارات",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className={`${cairo.variable} ${tajawal.variable} ${lemonada.variable}`}>
      <body className="min-h-screen flex flex-col antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
