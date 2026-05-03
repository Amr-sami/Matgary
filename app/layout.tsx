import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import "./globals.css";

const cairo = Cairo({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cairo",
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
    <html lang="ar" dir="rtl" className={cairo.variable}>
      <body className="min-h-screen flex flex-col antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}