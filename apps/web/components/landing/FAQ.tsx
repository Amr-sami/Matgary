"use client";

import { useState } from "react";
import { Plus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Reveal } from "./Reveal";

export function FAQ() {
  const { faq, common } = useDictionary();
  const locale = useLocale();
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="py-20 md:py-28 scroll-mt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div className="max-w-2xl mx-auto text-center mb-14">
            <span className="font-catchy inline-block text-accent text-base font-bold mb-3 tracking-wide">
              {faq.eyebrow}
            </span>
            <h2 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
              {faq.title}
            </h2>
          </div>
        </Reveal>

        <div className="border-t border-border">
          {faq.items.map((item, i) => {
            const isOpen = open === i;
            return (
              <Reveal key={item.q} delay={i * 40}>
                <div className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="group w-full flex items-center justify-between gap-4 py-5 md:py-6 text-start"
                  >
                    <span
                      className={cn(
                        "font-bold text-base md:text-lg transition-colors duration-200",
                        isOpen
                          ? "text-text-primary"
                          : "text-text-primary group-hover:text-accent",
                      )}
                    >
                      {item.q}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "relative shrink-0 w-7 h-7 rounded-full border flex items-center justify-center transition-all duration-300",
                        isOpen
                          ? "bg-accent border-accent text-white rotate-45"
                          : "border-border text-text-secondary group-hover:border-accent group-hover:text-accent",
                      )}
                    >
                      <Plus className="w-3.5 h-3.5" weight="bold" />
                    </span>
                  </button>
                  <div
                    className={cn(
                      "grid transition-all duration-300 ease-out",
                      isOpen
                        ? "grid-rows-[1fr] opacity-100 pb-5 md:pb-6"
                        : "grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div className="overflow-hidden">
                      <p className="text-text-secondary leading-relaxed pe-10 md:pe-12">
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={150}>
          <p className="text-center text-sm text-text-secondary mt-10">
            {faq.moreQuestion}{" "}
            <a
              href={`/${locale}/contact`}
              className="font-bold text-accent hover:underline underline-offset-4"
            >
              {common.contactUs}
            </a>
            .
          </p>
        </Reveal>
      </div>
    </section>
  );
}
