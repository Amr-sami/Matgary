import type { ReactNode } from "react";
import Link from "next/link";
import { AuthShowcase } from "./AuthShowcase";
import { Logo } from "@/components/brand/Logo";
import { LangSwitcher } from "@/components/i18n/LangSwitcher";
import { DemoLoginPill } from "@/components/auth/DemoLoginPill";

/**
 * Auth shell.
 *  - Mobile: blue rectangle on top + white form card below.
 *  - Desktop (lg+): two columns on a fully WHITE page background.
 *      • Form 60% on white, content centered.
 *      • Showcase 40% on white. Illustration nudged toward the start side
 *        (right in RTL) with a soft brand-tinted halo behind it for depth.
 *
 * Page never scrolls (h-screen on lg+).
 */
export default async function AuthLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  return (
    <div
      className="lg:h-screen min-h-screen relative bg-white overflow-hidden"
      style={{
        backgroundImage: "url(/auth-pattern.svg)",
        backgroundRepeat: "repeat",
      }}
    >
      {/* Locale switcher + demo CTA — top-end corner above the form column. */}
      <div className="absolute top-3 end-3 z-20 flex items-center gap-2">
        <DemoLoginPill />
        <LangSwitcher />
      </div>

      {/* In RTL the form is naturally on the right (first child); in LTR we
          reverse the row so the form still lands on the right and the
          showcase on the left — matching the requested "image left, form
          right" English layout. */}
      <div className="lg:flex lg:h-screen ltr:lg:flex-row-reverse">
        {/* ── FORM COLUMN — 60% desktop, full mobile ─────────── */}
        <div className="relative w-full lg:w-3/5 min-h-screen lg:min-h-0 lg:h-screen flex-shrink-0">
          <main className="relative h-full min-h-screen lg:min-h-0 lg:h-screen flex flex-col items-center justify-center py-8">
            <div className="w-full max-w-md mx-auto flex flex-col items-center px-4">
              <Link
                href={`/${lang}/welcome`}
                aria-label="TheStoro"
                className="mb-6 text-accent rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                <Logo size="lg" locale={lang} />
              </Link>
              {children}
            </div>
          </main>
        </div>

        {/* ── SHOWCASE COLUMN — 40% desktop, white bg ────────── */}
        <AuthShowcase />
      </div>
    </div>
  );
}
