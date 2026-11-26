"use client";

import { AtSign, Phone, MessageCircle, Clock } from "@/lib/icons";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

const ICONS = { email: AtSign, whatsapp: MessageCircle, phone: Phone, hours: Clock } as const;
type ChannelKey = keyof typeof ICONS;

export function ContactContent() {
  const { marketing } = useDictionary();
  const locale = useLocale();
  const c = marketing.contact;
  const channels = (Object.keys(ICONS) as ChannelKey[]).map((key) => ({
    icon: ICONS[key],
    ...c.channels[key],
  }));

  return (
    <>
      <PageHeader eyebrow={c.eyebrow} title={c.title} lead={c.lead} />

      <section className="py-16 md:py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <div className="grid sm:grid-cols-2 gap-4">
            {channels.map((ch, i) => (
              <Reveal key={ch.title} delay={i * 60}>
                <div className="bg-white border border-border rounded-2xl p-6 h-full hover:border-accent/40 transition-colors">
                  <div className="flex items-start gap-4">
                    <span className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent-light text-accent">
                      <ch.icon className="w-5 h-5" weight="bold" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-bold text-text-primary text-base">
                        {ch.title}
                      </h3>
                      <p
                        className="font-display font-bold text-text-primary text-lg mt-1 break-words"
                        dir="ltr"
                      >
                        {ch.detail}
                      </p>
                      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                        {ch.note}
                      </p>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <p className="text-center text-sm text-text-secondary mt-12">
              {c.faqHint}{" "}
              <a
                href={`/${locale}/welcome#faq`}
                className="font-bold text-accent hover:underline underline-offset-4"
              >
                {c.faqLink}
              </a>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
