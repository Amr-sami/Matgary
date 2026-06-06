import type { ReactNode } from "react";
import { AuthShowcase } from "./AuthShowcase";
import { Logo } from "@/components/brand/Logo";
import { LangSwitcher } from "@/components/i18n/LangSwitcher";

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
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="lg:h-screen min-h-screen relative bg-white overflow-hidden"
      style={{
        backgroundImage: "url(/auth-pattern.svg)",
        backgroundRepeat: "repeat",
      }}
    >
      {/* Locale switcher — floats above the form column, top-end corner. */}
      <div className="absolute top-3 end-3 z-20">
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
              <div className="mb-6 text-accent">
                <Logo size="lg" />
              </div>
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
