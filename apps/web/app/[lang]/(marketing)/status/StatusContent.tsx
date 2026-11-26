"use client";

import { CheckCircle } from "@/lib/icons";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

export function StatusContent() {
  const { marketing } = useDictionary();
  const locale = useLocale();
  const s = marketing.status;
  return (
    <>
      <PageHeader eyebrow={s.eyebrow} title={s.title} />

      <section className="py-12 md:py-16">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <Reveal>
            <div className="bg-success/5 border border-success/30 rounded-2xl px-6 py-5 flex items-center gap-3 mb-8">
              <CheckCircle
                className="w-6 h-6 text-success shrink-0"
                weight="fill"
              />
              <div>
                <p className="font-bold text-text-primary">{s.allOperational}</p>
                <p className="text-sm text-text-secondary mt-0.5">
                  {s.lastUpdated}
                </p>
              </div>
            </div>
          </Reveal>

          <div className="bg-white border border-border rounded-2xl overflow-hidden">
            {s.services.map((name, i) => (
              <Reveal key={name} delay={i * 30}>
                <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border last:border-0">
                  <span className="font-medium text-text-primary text-sm md:text-base">
                    {name}
                  </span>
                  <span className="flex items-center gap-2 text-xs md:text-sm text-text-secondary">
                    <span
                      className="w-2 h-2 rounded-full bg-success"
                      aria-hidden
                    />
                    {s.operationalLabel}
                  </span>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={150}>
            <p className="text-center text-xs text-text-secondary mt-8">
              {s.reportHint}{" "}
              <a
                href={`/${locale}/contact`}
                className="font-bold text-accent hover:underline underline-offset-4"
              >
                {s.reportLink}
              </a>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
