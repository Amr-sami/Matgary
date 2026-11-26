"use client";

import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export function PrivacyContent() {
  const { marketing } = useDictionary();
  const p = marketing.privacy;
  return (
    <>
      <PageHeader eyebrow={p.eyebrow} title={p.title} lead={p.lead} />

      <section className="py-16 md:py-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 space-y-8">
          {p.sections.map((s, i) => (
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
