"use client";

import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export function TermsContent() {
  const { marketing } = useDictionary();
  const t = marketing.terms;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} lead={t.lead} />

      <section className="py-16 md:py-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 space-y-8">
          {t.sections.map((s, i) => (
            <Reveal key={s.title} delay={i * 30}>
              <div>
                <h2 className="font-display font-bold text-xl text-text-primary mb-2">
                  {s.title}
                </h2>
                <p className="text-text-secondary leading-relaxed">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
