"use client";

import Image from "next/image";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export function AuthShowcase() {
  const { auth } = useDictionary();
  const s = auth.showcase;
  return (
    <div className="hidden lg:flex lg:w-2/5 bg-white relative items-center justify-center overflow-hidden">
      {/* Showcase column always sits on the left of the page (RTL natural,
          LTR via flex-row-reverse on the parent). Internal positioning uses
          physical left/right so the halo/illustration always hug the
          form-facing edge (right side of the column) regardless of dir. */}
      <div
        aria-hidden
        className="absolute top-1/2 -translate-y-1/2 right-12 w-[420px] h-[420px] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(18,3,227,0.08) 0%, transparent 65%)",
        }}
      />
      {/* Tiny floating dot accents for texture */}
      <div className="absolute top-16 right-16 w-1.5 h-1.5 rounded-full bg-accent/30" />
      <div className="absolute bottom-20 left-12 w-2 h-2 rounded-full bg-accent/20" />
      <div className="absolute top-1/3 left-20 w-1 h-1 rounded-full bg-accent/40" />

      <div
        className="relative z-10 w-full h-full flex flex-col justify-center items-stretch pl-12 pr-2 xl:pl-16 xl:pr-2 py-12 gap-8"
        style={{ animation: "auth-rise 600ms cubic-bezier(0.2,0.8,0.2,1) both" }}
      >
        {/* Image hugged to the form-facing edge (= right of showcase) in
            both directions. `justify-*` is dir-aware, so RTL uses start
            (= right) and LTR uses end (= right). */}
        <div className="flex rtl:justify-start ltr:justify-end">
          <div className="w-full max-w-[440px]">
            <Image
              src="/market-launch.svg"
              alt={s.imageAlt}
              width={480}
              height={320}
              priority
              className="w-full h-auto select-none drop-shadow-sm"
            />
          </div>
        </div>

        {/* Typography block also hugged to the right edge of the showcase
            (via `self-*`), but its INNER content reads in the natural
            direction — Arabic right-aligned, English left-aligned within
            its 420px box. */}
        <div className="flex flex-col items-start text-start max-w-[420px] rtl:self-start ltr:self-end">
          <h2 className="font-display font-black text-4xl xl:text-[44px] text-text-primary leading-[1.05] tracking-tight">
            {s.headlineA}
            <br />
            <span className="font-catchy text-accent text-5xl xl:text-[56px] inline-block align-baseline">
              {s.headlineB}
            </span>{" "}
            {s.headlineC}
          </h2>

          <div className="mt-5 mb-5 flex items-center gap-2">
            <span className="h-[2px] w-8 bg-accent rounded-full" />
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          </div>

          <p className="font-display font-medium text-text-secondary text-base xl:text-[17px] leading-[1.7]">
            {s.lead}
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
  );
}
