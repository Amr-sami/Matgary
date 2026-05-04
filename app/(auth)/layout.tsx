import type { ReactNode } from "react";
import Image from "next/image";
import { Logo } from "@/components/brand/Logo";

/**
 * Auth shell.
 *  - Mobile: blue rectangle on top + white form card below.
 *  - Desktop (lg+): two columns on a fully WHITE page background.
 *      • Form 60% on white, content centered.
 *      • Showcase 40% on white. Illustration nudged toward the start side
 *        (right in RTL) with a soft brand-tinted halo behind it for depth.
 *        Display headline + body in tight vertical rhythm.
 *
 * Page never scrolls (h-screen on lg+).
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="lg:h-screen min-h-screen relative bg-white overflow-hidden">
      <div className="lg:flex lg:h-screen">
        {/* ── FORM COLUMN — 60% desktop, full mobile ─────────── */}
        <div className="relative w-full lg:w-3/5 lg:bg-white min-h-screen lg:min-h-0 lg:h-screen flex-shrink-0">
          {/* Blue rectangle ONLY on mobile */}
          <div className="absolute inset-x-0 top-0 h-[68vh] bg-accent lg:hidden" />

          <main className="relative h-full min-h-screen lg:min-h-0 lg:h-screen flex flex-col items-center justify-center py-8">
            <div className="w-full max-w-md mx-auto flex flex-col items-center px-4">
              <div className="mb-6 text-white lg:text-accent">
                <Logo size="lg" />
              </div>
              {children}
            </div>
          </main>
        </div>

        {/* ── SHOWCASE COLUMN — 40% desktop, white bg ────────── */}
        <div className="hidden lg:flex lg:w-2/5 bg-white relative items-center justify-center overflow-hidden">
          {/* Soft brand-tinted halo blob — sits behind the illustration */}
          <div
            aria-hidden
            className="absolute top-1/2 -translate-y-1/2 start-12 w-[420px] h-[420px] rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgba(18,3,227,0.08) 0%, transparent 65%)",
            }}
          />
          {/* Tiny floating dot accents for texture */}
          <div className="absolute top-16 start-16 w-1.5 h-1.5 rounded-full bg-accent/30" />
          <div className="absolute bottom-20 end-12 w-2 h-2 rounded-full bg-accent/20" />
          <div className="absolute top-1/3 end-20 w-1 h-1 rounded-full bg-accent/40" />

          <div
            className="relative z-10 w-full h-full flex flex-col justify-center items-stretch ps-2 pe-12 xl:ps-2 xl:pe-16 py-12 gap-8"
            style={{ animation: "auth-rise 600ms cubic-bezier(0.2,0.8,0.2,1) both" }}
          >
            {/* Illustration — anchored to the right (RTL start) with breathing room from the left */}
            <div className="flex justify-start">
              <div className="w-full max-w-[440px]">
                <Image
                  src="/market-launch.svg"
                  alt="انطلاقة متجرك"
                  width={480}
                  height={320}
                  priority
                  className="w-full h-auto select-none drop-shadow-sm"
                />
              </div>
            </div>

            {/* Typography — aligned to the start, max-w controlled for rhythm */}
            <div className="flex flex-col items-start text-start max-w-[420px]">
              <h2 className="font-display font-black text-4xl xl:text-[44px] text-text-primary leading-[1.05] tracking-tight">
                انطلق
                <br />
                <span className="font-catchy text-accent text-5xl xl:text-[56px] inline-block align-baseline">
                  بمتجرك
                </span>{" "}
                للسماء
              </h2>

              <div className="mt-5 mb-5 flex items-center gap-2">
                <span className="h-[2px] w-8 bg-accent rounded-full" />
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              </div>

              <p className="font-display font-medium text-text-secondary text-base xl:text-[17px] leading-[1.7]">
                نظامك الكامل لإدارة المبيعات والمخزون — مصمَّم خصيصاً للمتاجر
                العربية لتنمو بثقة وسرعة.
              </p>
            </div>
          </div>

          <style>{`
            @keyframes auth-rise {
              from { opacity: 0; transform: translateY(12px); }
              to   { opacity: 1; transform: translateY(0); }
            }
          `}</style>
        </div>
      </div>
    </div>
  );
}
