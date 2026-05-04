"use client";

import Link from "next/link";
import {
  ShoppingCart,
  Package,
  Users,
  Receipt,
  ChevronLeft,
} from "@/lib/icons";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";

const TOPICS = [
  {
    icon: ShoppingCart,
    title: "البدء ونقطة البيع",
    body: "إعداد الحساب، أول عملية بيع، الطباعة، والإيصالات.",
  },
  {
    icon: Package,
    title: "المخزون والمنتجات",
    body: "إضافة المنتجات، الباركود، الفئات، وتنبيهات النفاد.",
  },
  {
    icon: Users,
    title: "الفريق والصلاحيات",
    body: "إنشاء حسابات الموظفين وتحديد ما يستطيعون رؤيته وفعله.",
  },
  {
    icon: Receipt,
    title: "التقارير والمالية",
    body: "قراءة التقارير اليومية، المصروفات، والمرتجعات.",
  },
];

export function HelpContent() {
  return (
    <>
      <PageHeader
        eyebrow="مركز المساعدة"
        title="ابحث عن إجابة سريعة"
        lead="اختر الموضوع المتعلق باستفسارك — أو راجع الأسئلة الشائعة، أو تواصل معنا مباشرة."
      />

      <section className="py-16 md:py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <div className="grid sm:grid-cols-2 gap-4">
            {TOPICS.map((t, i) => (
              <Reveal key={t.title} delay={i * 60}>
                <Link
                  href="/contact"
                  className="group block bg-white border border-border rounded-2xl p-6 h-full hover:border-accent transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent-light text-accent">
                      <t.icon className="w-5 h-5" weight="bold" />
                    </span>
                    <ChevronLeft className="w-5 h-5 text-text-secondary group-hover:text-accent group-hover:-translate-x-0.5 transition-all" />
                  </div>
                  <h3 className="font-display font-bold text-lg text-text-primary mt-4">
                    {t.title}
                  </h3>
                  <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                    {t.body}
                  </p>
                </Link>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <div className="mt-12 rounded-2xl border border-border bg-bg-card/60 px-6 py-7 md:px-8 md:py-8 text-center">
              <h3 className="font-display font-bold text-lg text-text-primary">
                ما لقيت إجابتك؟
              </h3>
              <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                فريق الدعم بيرد في أيام العمل خلال 24 ساعة.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 mt-5">
                <Link
                  href="/welcome#faq"
                  className="text-sm font-bold text-accent hover:underline underline-offset-4"
                >
                  راجع الأسئلة الشائعة
                </Link>
                <span className="w-1 h-1 rounded-full bg-border" />
                <Link
                  href="/contact"
                  className="text-sm font-bold text-accent hover:underline underline-offset-4"
                >
                  تواصل مع الدعم
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
