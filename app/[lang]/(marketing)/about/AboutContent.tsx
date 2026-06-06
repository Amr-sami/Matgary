"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

export function AboutContent() {
  const { marketing } = useDictionary();
  const locale = useLocale();
  const a = marketing.about;
  return (
    <>
      <PageHeader eyebrow={a.eyebrow} title={a.title} lead={a.lead} />

      <section className="py-16 md:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <Reveal>
            <div className="prose-content space-y-6 text-text-secondary leading-relaxed text-base md:text-lg">
              <p>{a.p1}</p>
              <p>{a.p2}</p>
            </div>
          </Reveal>

          <div className="grid md:grid-cols-3 gap-6 mt-14">
            {a.values.map((v, i) => (
              <Reveal key={v.title} delay={i * 80}>
                <div className="bg-white border border-border rounded-2xl p-6 h-full">
                  <h3 className="font-display font-bold text-lg text-text-primary mb-2">
                    {v.title}
                  </h3>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {v.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={150}>
            <div className="mt-16 text-center">
              <Link href={`/${locale}/signup`}>
                <Button className="px-7 py-3 text-base">{a.tryCta}</Button>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
