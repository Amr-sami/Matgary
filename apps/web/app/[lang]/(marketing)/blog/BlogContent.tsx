"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

export function BlogContent() {
  const { marketing, common } = useDictionary();
  const locale = useLocale();
  const b = marketing.blog;
  return (
    <>
      <PageHeader eyebrow={b.eyebrow} title={b.title} lead={b.lead} />

      <section className="py-16 md:py-20">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 text-center">
          <Reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent-light text-accent text-xs font-bold tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {b.badge}
            </div>
            <p className="text-text-secondary leading-relaxed mt-6">{b.body}</p>
            <div className="mt-8">
              <Link href={`/${locale}/contact`}>
                <Button variant="secondary" className="px-6 py-2.5">
                  {common.contactUs}
                </Button>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
