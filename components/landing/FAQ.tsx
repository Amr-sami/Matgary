"use client";

import { useState } from "react";
import { ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Reveal } from "./Reveal";

const FAQS = [
  {
    q: "هل أحتاج بطاقة ائتمان للبدء؟",
    a: "لا. يمكنك إنشاء حسابك وتجربة كل المميزات مجاناً بدون أي بطاقة دفع.",
  },
  {
    q: "هل يعمل النظام على الموبايل؟",
    a: "نعم — كل الواجهات مصممة للعمل على الهاتف والتابلت بنفس سلاسة الكمبيوتر، بما فيها نقطة البيع.",
  },
  {
    q: "هل أستطيع إضافة موظفين بصلاحيات محددة؟",
    a: "بالطبع. أنشئ حسابات للموظفين وحدد ما يستطيعون رؤيته (المخزن، التقارير، الإعدادات…) وما يستطيعون فعله، كل ذلك بضغطة زر.",
  },
  {
    q: "هل بياناتي آمنة؟",
    a: "نعم. كل متجر يعمل في عزل تام عن المتاجر الأخرى على مستوى قاعدة البيانات (Row-Level Security)، وكل البيانات الحساسة مشفّرة.",
  },
  {
    q: "ماذا يحدث إذا انقطع الإنترنت؟",
    a: "نقطة البيع تستمر بالعمل وتسجل العمليات محلياً، ثم تتزامن تلقائياً عند عودة الاتصال — لن تخسر أي بيع.",
  },
  {
    q: "هل أستطيع استيراد منتجاتي القديمة؟",
    a: "نعم. ندعم الاستيراد عبر ملفات CSV، وفريق الدعم يساعدك في النقل من أي نظام آخر.",
  },
];

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="py-20 md:py-28">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div className="text-center mb-12">
            <span className="font-catchy inline-block text-accent text-base font-bold mb-3 tracking-wide">
              أسئلة شائعة
            </span>
            <h2 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
              ما يدور في بال الجميع
            </h2>
          </div>
        </Reveal>

        <div className="space-y-3">
          {FAQS.map((item, i) => {
            const isOpen = open === i;
            return (
              <Reveal key={item.q} delay={i * 50}>
                <div
                  className={cn(
                    "bg-white border rounded-xl transition-all duration-300",
                    isOpen
                      ? "border-accent shadow-md"
                      : "border-border hover:border-accent/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center justify-between gap-4 p-5 text-start"
                  >
                    <span className="font-bold text-text-primary text-base md:text-lg">
                      {item.q}
                    </span>
                    <ChevronDown
                      className={cn(
                        "w-5 h-5 text-accent shrink-0 transition-transform duration-300",
                        isOpen && "rotate-180",
                      )}
                    />
                  </button>
                  <div
                    className={cn(
                      "overflow-hidden transition-[max-height,opacity,padding] duration-300 ease-out",
                      isOpen ? "max-h-60 opacity-100" : "max-h-0 opacity-0",
                    )}
                  >
                    <p className="px-5 pb-5 text-text-secondary leading-relaxed">
                      {item.a}
                    </p>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
