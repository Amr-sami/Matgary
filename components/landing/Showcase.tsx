"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { Check } from "@/lib/icons";
import { Reveal } from "./Reveal";

interface Row {
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  art: ReactNode;
  /** "start" → illustration on the page-start side (right in RTL). "end" → opposite. */
  side: "start" | "end";
}

const ROWS: Row[] = [
  {
    eyebrow: "المخزن",
    title: "إدارة المخزون بدون أخطاء",
    body: "تتبع كل قطعة في متجرك من لحظة وصولها حتى بيعها. الجرد التلقائي يكتشف الناقص قبل أن يصبح مشكلة.",
    bullets: [
      "تنبيهات عند نفاد الكمية",
      "أصناف فرعية وخصائص مرنة",
      "استيراد قوائم المنتجات بـCSV",
    ],
    art: (
      <Image
        src="/illustrations/landing/unboxing.svg"
        alt="إدارة المخزون"
        width={520}
        height={420}
        className="w-full max-w-md h-auto select-none drop-shadow-sm"
      />
    ),
    side: "start",
  },
  {
    eyebrow: "نقطة البيع",
    title: "نقطة بيع تواكب سرعة عملك",
    body: "افتح الفاتورة، امسح الباركود، اطبع الإيصال — كل ذلك في ثوانٍ. تعمل من أي جهاز، حتى بدون إنترنت مؤقتاً.",
    bullets: [
      "دعم كامل للباركود والقارئات",
      "دفع نقدي، شبكة، أو آجل",
      "إيصالات حرارية وPDF",
    ],
    art: (
      <Image
        src="/illustrations/landing/sleek.svg"
        alt="نقطة بيع سريعة"
        width={520}
        height={420}
        className="w-full max-w-md h-auto select-none drop-shadow-sm"
      />
    ),
    side: "end",
  },
  {
    eyebrow: "التقارير",
    title: "تقارير تفهم متجرك",
    body: "ليست أرقاماً جامدة. تحليلات ذكية تخبرك أي صنف يجلب الربح، أي ساعة هي الأكثر ازدحاماً، وأي عميل عاد آخر مرة.",
    bullets: [
      "خرائط حرارية للمبيعات بالساعة",
      "أفضل المنتجات والعملاء",
      "مقارنات يومية وشهرية",
    ],
    art: (
      <Image
        src="/illustrations/landing/sitting-reading.svg"
        alt="تحليل التقارير"
        width={520}
        height={420}
        className="w-full max-w-md h-auto select-none drop-shadow-sm"
      />
    ),
    side: "start",
  },
];

export function Showcase() {
  return (
    <section className="relative py-20 md:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-24 md:space-y-32">
        {ROWS.map((row) => (
          <ShowcaseRow key={row.title} row={row} />
        ))}
      </div>
    </section>
  );
}

function ShowcaseRow({ row }: { row: Row }) {
  const artOrder = row.side === "start" ? "md:order-first" : "md:order-last";
  const artDirection = row.side === "start" ? "start" : "end";
  const textDirection = row.side === "start" ? "end" : "start";

  return (
    <div className="grid md:grid-cols-2 gap-10 md:gap-16 items-center">
      <Reveal direction={artDirection} className={artOrder}>
        <div className="relative flex items-center justify-center min-h-[260px]">
          {/* soft halo blob behind the art */}
          <div
            aria-hidden
            className="absolute inset-0 -z-10 rounded-3xl blur-2xl scale-95"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, rgba(18,3,227,0.12), transparent 70%)",
            }}
          />
          {row.art}
        </div>
      </Reveal>

      <Reveal direction={textDirection}>
        <div className="space-y-5">
          <span className="font-catchy inline-block text-accent text-base font-bold tracking-wide">
            {row.eyebrow}
          </span>
          <h3 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
            {row.title}
          </h3>
          <p className="text-text-secondary text-base md:text-lg leading-relaxed">
            {row.body}
          </p>
          <ul className="space-y-2.5 pt-2">
            {row.bullets.map((b) => (
              <li key={b} className="flex items-start gap-3">
                <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent-light">
                  <Check className="w-3 h-3 text-accent" />
                </span>
                <span className="text-text-primary text-sm md:text-base">
                  {b}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Reveal>
    </div>
  );
}
