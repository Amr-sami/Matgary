"use client";

import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { Reveal } from "./Reveal";

export function Stats() {
  const dict = useDictionary();
  const STATS = [
    { value: "‎99.9%", label: dict.stats.uptime },
    { value: "‎<1s", label: dict.stats.saleSpeed },
    { value: "‎24/7", label: dict.stats.support },
    { value: "‎ ∞ ", label: dict.stats.unlimited },
  ];
  return (
    <section className="py-12 md:py-16 border-y border-border bg-bg-card/60">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 70}>
              <div className="text-center">
                <p
                  dir="ltr"
                  className="font-display font-black text-3xl md:text-4xl text-accent leading-none tracking-tight"
                >
                  {s.value}
                </p>
                <p className="text-xs md:text-sm text-text-secondary mt-2">
                  {s.label}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
