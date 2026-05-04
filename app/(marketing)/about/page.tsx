import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";

export const metadata = {
  title: "من نحن — متجري",
  description:
    "متجري نظام عربي لإدارة المتاجر — قصتنا، رسالتنا، والقيم اللي بنبني بيها.",
};

const VALUES = [
  {
    title: "البساطة أولاً",
    body: "نظام يفتحه أي بائع ويستخدمه من أول دقيقة — بدون تدريب طويل أو واجهات معقدة.",
  },
  {
    title: "بيانات تخصك أنت",
    body: "متجرك معزول تماماً عن غيره على مستوى قاعدة البيانات. ما تخصك من بيانات يبقى تحت يدك.",
  },
  {
    title: "نُصمَّم بالعربية",
    body: "كل شاشة، كل زر، كل تقرير — مكتوب أصلاً بالعربية، ومن صانعين يفهمون السوق.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHeader
        eyebrow="من نحن"
        title="بنبني الأداة اللي كنا نتمناها"
        lead="بدأنا متجري لأن أصحاب المحلات كانوا بيستخدموا أنظمة معقدة، أو أكسل، أو دفاتر — وكل واحد فيهم بيخسّر وقت أو فلوس. قررنا نعمل نظام واحد، عربي، بسيط، ويشتغل."
      />

      <section className="py-16 md:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6">
          <Reveal>
            <div className="prose-content space-y-6 text-text-secondary leading-relaxed text-base md:text-lg">
              <p>
                متجري نظام إدارة متاجر متكامل — نقطة بيع، مخزون، تقارير، فريق
                وصلاحيات — كل ده في مكان واحد. بنخدم أصحاب المحلات الصغيرة
                والمتوسطة في مصر والمنطقة العربية، وبنتعامل مع كل متجر كأنه
                مشروع شخصي، مش رقم.
              </p>
              <p>
                فلسفتنا بسيطة: المتاجر مش محتاجة أكتر مما تحتاج. محتاجة أداة
                واحدة، شغالة، بتفهم اللي بيحصل في المحل، وبتساعد صاحبها يقرّر
                صح. كل ميزة بنبنيها، بنسأل نفسنا قبلها: هل البائع هيستخدمها كل
                يوم؟ لو الإجابة لا، ما بنعملهاش.
              </p>
            </div>
          </Reveal>

          <div className="grid md:grid-cols-3 gap-6 mt-14">
            {VALUES.map((v, i) => (
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
              <Link href="/signup">
                <Button className="px-7 py-3 text-base">جرّب متجري</Button>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
