"use client";

import Link from "next/link";
import { Check } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Reveal } from "./Reveal";
import { cn } from "@/lib/utils";

interface Plan {
  name: string;
  price: string;
  period: string;
  effective?: string;
  cta: string;
  ctaHref: string;
  highlighted?: boolean;
}

export function Pricing() {
  const { pricing } = useDictionary();
  const locale = useLocale();
  const signupHref = `/${locale}/signup`;
  const PLANS: Plan[] = [
    { ...pricing.plans.monthly, ctaHref: signupHref },
    { ...pricing.plans.yearly, ctaHref: signupHref, highlighted: true },
    { ...pricing.plans.threeYear, ctaHref: signupHref },
  ];

  return (
    <section id="pricing" className="relative py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div className="max-w-2xl mx-auto text-center mb-14">
            <span className="font-catchy inline-block text-accent text-base font-bold mb-3 tracking-wide">
              {pricing.eyebrow}
            </span>
            <h2 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
              {pricing.title}
            </h2>
            <p className="text-text-secondary mt-4 leading-relaxed">
              {pricing.subhead}
            </p>
          </div>
        </Reveal>

        {/* Plan cards row */}
        <div className="grid md:grid-cols-3 gap-px bg-border rounded-2xl overflow-hidden border border-border">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 80}>
              <PlanCard plan={plan} currency={pricing.currency} recommendedLabel={pricing.recommended} />
            </Reveal>
          ))}
        </div>

        {/* Shared features strip */}
        <Reveal delay={250}>
          <div className="mt-10 md:mt-12 rounded-2xl border border-border bg-bg-card/60 px-6 py-7 md:px-10 md:py-9">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
              <div className="md:max-w-[18rem]">
                <p className="font-catchy text-accent text-sm font-bold tracking-wide mb-1">
                  {pricing.includedEyebrow}
                </p>
                <h3 className="font-display font-bold text-xl text-text-primary leading-snug">
                  {pricing.includedTitle}
                </h3>
                <p className="text-sm text-text-secondary mt-2 leading-relaxed">
                  {pricing.includedBody}
                </p>
              </div>
              <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-3 md:flex-1">
                {pricing.included.map((f) => (
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
            {pricing.disclaimer}
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function PlanCard({
  plan,
  currency,
  recommendedLabel,
}: {
  plan: Plan;
  currency: string;
  recommendedLabel: string;
}) {
  return (
    <article
      className={cn(
        "relative bg-white p-7 md:p-8 flex flex-col h-full",
        plan.highlighted && "bg-accent-light/40",
      )}
    >
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
            {recommendedLabel}
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
          <span className="text-base font-bold text-text-secondary">{currency}</span>
          <span className="text-sm text-text-secondary">{plan.period}</span>
        </div>
        <p className="text-xs text-text-secondary min-h-[1rem]">
          {plan.effective ?? " "}
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
