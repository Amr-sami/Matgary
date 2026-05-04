"use client";

import { CheckCircle } from "@/lib/icons";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";

const SERVICES = [
  { name: "نقطة البيع (POS)", status: "operational" as const },
  { name: "المخزون والمنتجات", status: "operational" as const },
  { name: "التقارير والتحليلات", status: "operational" as const },
  { name: "تسجيل الدخول والصلاحيات", status: "operational" as const },
  { name: "الكتالوج العام", status: "operational" as const },
  { name: "إيصالات واتساب", status: "operational" as const },
];

const STATUS_LABEL: Record<"operational", { label: string; dot: string }> = {
  operational: { label: "تعمل بشكل طبيعي", dot: "bg-success" },
};

export function StatusContent() {
  return (
    <>
      <PageHeader
        eyebrow="حالة الخدمة"
        title="كل الخدمات تعمل بشكل طبيعي"
      />

      <section className="py-12 md:py-16">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <Reveal>
            <div className="bg-success/5 border border-success/30 rounded-2xl px-6 py-5 flex items-center gap-3 mb-8">
              <CheckCircle
                className="w-6 h-6 text-success shrink-0"
                weight="fill"
              />
              <div>
                <p className="font-bold text-text-primary">
                  جميع الأنظمة تعمل بشكل طبيعي
                </p>
                <p className="text-sm text-text-secondary mt-0.5">
                  آخر تحديث: منذ دقائق
                </p>
              </div>
            </div>
          </Reveal>

          <div className="bg-white border border-border rounded-2xl overflow-hidden">
            {SERVICES.map((s, i) => {
              const meta = STATUS_LABEL[s.status];
              return (
                <Reveal key={s.name} delay={i * 30}>
                  <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border last:border-0">
                    <span className="font-medium text-text-primary text-sm md:text-base">
                      {s.name}
                    </span>
                    <span className="flex items-center gap-2 text-xs md:text-sm text-text-secondary">
                      <span
                        className={`w-2 h-2 rounded-full ${meta.dot}`}
                        aria-hidden
                      />
                      {meta.label}
                    </span>
                  </div>
                </Reveal>
              );
            })}
          </div>

          <Reveal delay={150}>
            <p className="text-center text-xs text-text-secondary mt-8">
              للإبلاغ عن مشكلة، تواصل معنا عبر{" "}
              <a
                href="/contact"
                className="font-bold text-accent hover:underline underline-offset-4"
              >
                صفحة التواصل
              </a>
              .
            </p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
