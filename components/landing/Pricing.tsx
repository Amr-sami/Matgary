"use client";

import Link from "next/link";
import { Check } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Reveal } from "./Reveal";
import { cn } from "@/lib/utils";

interface Plan {
  name: string;
  price: string;
  /** What you actually pay this billing cycle ("/شهر", "/سنة", " إجمالاً"). */
  period: string;
  /** Effective monthly rate, shown small under the price. Empty for the monthly plan. */
  effective?: string;
  cta: string;
  ctaHref: string;
  highlighted?: boolean;
}

const PLANS: Plan[] = [
  {
    name: "شهري",
    price: "300",
    period: "/شهر",
    cta: "اختر الشهري",
    ctaHref: "/signup",
  },
  {
    name: "سنوي",
    price: "2,500",
    period: "/سنة",
    effective: "208 ج.م شهرياً",
    cta: "اختر السنوي",
    ctaHref: "/signup",
    highlighted: true,
  },
  {
    name: "3 سنوات",
    price: "6,000",
    period: " إجمالاً",
    effective: "167 ج.م شهرياً",
    cta: "اختر 3 سنوات",
    ctaHref: "/signup",
  },
];

const INCLUDED = [
  "نقطة بيع كاملة",
  "مخزون بدون حد",
  "تقارير وتحليلات لحظية",
  "فريق وصلاحيات",
  "إيصالات واتساب",
  "كتالوج عام بنطاق مخصص",
];

export function Pricing() {
  return (
    <section id="pricing" className="relative py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div className="max-w-2xl mx-auto text-center mb-14">
            <span className="font-catchy inline-block text-accent text-base font-bold mb-3 tracking-wide">
              الأسعار
            </span>
            <h2 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
              خطة واحدة. اختر مدة الدفع.
            </h2>
            <p className="text-text-secondary mt-4 leading-relaxed">
              المميزات نفسها في كل خطة — الفرق فقط في مدة الاشتراك والسعر
              الإجمالي.
            </p>
          </div>
        </Reveal>

        {/* Plan cards row */}
        <div className="grid md:grid-cols-3 gap-px bg-border rounded-2xl overflow-hidden border border-border">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 80}>
              <PlanCard plan={plan} />
            </Reveal>
          ))}
        </div>

        {/* Shared features strip */}
        <Reveal delay={250}>
          <div className="mt-10 md:mt-12 rounded-2xl border border-border bg-bg-card/60 px-6 py-7 md:px-10 md:py-9">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
              <div className="md:max-w-[18rem]">
                <p className="font-catchy text-accent text-sm font-bold tracking-wide mb-1">
                  ما يشمله الاشتراك
                </p>
                <h3 className="font-display font-bold text-xl text-text-primary leading-snug">
                  كل المميزات في كل الخطط
                </h3>
                <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                  لا توجد خطة "أساسية" بمميزات مقطوعة. الجميع يحصل على
                  النظام بكامله.
                </p>
              </div>
              <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-3 md:flex-1">
                {INCLUDED.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2.5 text-text-primary text-sm"
                  >
                    <Check className="w-4 h-4 text-accent shrink-0" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>

        <Reveal>
          <p className="text-center text-xs text-text-secondary mt-8">
            الأسعار بالجنيه المصري — يمكن إلغاء الاشتراك في أي وقت.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <article
      className={cn(
        "relative bg-white p-7 md:p-8 flex flex-col h-full",
        plan.highlighted && "bg-accent-light/40",
      )}
    >
      {/* Subtle top accent bar for the recommended plan */}
      {plan.highlighted && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px] bg-accent"
        />
      )}

      <div className="flex items-baseline justify-between gap-3 mb-6">
        <h3 className="font-display font-bold text-base text-text-primary">
          {plan.name}
        </h3>
        {plan.highlighted && (
          <span className="text-[10px] font-bold text-accent uppercase tracking-[0.18em]">
            موصى به
          </span>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span
            dir="ltr"
            className="font-display font-black text-5xl text-text-primary tracking-tight leading-none"
          >
            {plan.price}
          </span>
          <span className="text-base font-bold text-text-secondary">ج.م</span>
          <span className="text-sm text-text-secondary">{plan.period}</span>
        </div>
        <p className="text-xs text-text-secondary min-h-[1rem]">
          {plan.effective ?? " "}
        </p>
      </div>

      <div className="flex-1" />

      <Link href={plan.ctaHref} className="block mt-8">
        <Button
          variant={plan.highlighted ? "primary" : "secondary"}
          className="w-full py-2.5"
        >
          {plan.cta}
        </Button>
      </Link>
    </article>
  );
}
