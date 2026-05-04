"use client";

import { AtSign, Phone, MessageCircle, Clock } from "@/lib/icons";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";

const CHANNELS = [
  {
    icon: AtSign,
    title: "البريد الإلكتروني",
    detail: "hello@matjari.app",
    note: "الرد خلال 24 ساعة في أيام العمل.",
  },
  {
    icon: MessageCircle,
    title: "واتساب",
    detail: "+20 100 000 0000",
    note: "للاستفسارات السريعة وطلبات الدعم.",
  },
  {
    icon: Phone,
    title: "اتصال هاتفي",
    detail: "+20 2 0000 0000",
    note: "خلال ساعات العمل الرسمية.",
  },
  {
    icon: Clock,
    title: "ساعات العمل",
    detail: "الأحد – الخميس",
    note: "9 صباحاً حتى 6 مساءً (بتوقيت القاهرة).",
  },
];

export function ContactContent() {
  return (
    <>
      <PageHeader
        eyebrow="تواصل معنا"
        title="فريقنا جاهز يسمعك"
        lead="عندك سؤال، اقتراح، أو محتاج مساعدة في إعداد متجرك؟ اختر الطريقة الأنسب ليك واحنا نرد."
      />

      <section className="py-16 md:py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <div className="grid sm:grid-cols-2 gap-4">
            {CHANNELS.map((c, i) => (
              <Reveal key={c.title} delay={i * 60}>
                <div className="bg-white border border-border rounded-2xl p-6 h-full hover:border-accent/40 transition-colors">
                  <div className="flex items-start gap-4">
                    <span className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent-light text-accent">
                      <c.icon className="w-5 h-5" weight="bold" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-bold text-text-primary text-base">
                        {c.title}
                      </h3>
                      <p
                        className="font-display font-bold text-text-primary text-lg mt-1 break-words"
                        dir="ltr"
                      >
                        {c.detail}
                      </p>
                      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                        {c.note}
                      </p>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <p className="text-center text-sm text-text-secondary mt-12">
              للأسئلة المتكررة، يمكنك زيارة{" "}
              <a
                href="/welcome#faq"
                className="font-bold text-accent hover:underline underline-offset-4"
              >
                صفحة الأسئلة الشائعة
              </a>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
