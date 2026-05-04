import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/landing/PageHeader";
import { Reveal } from "@/components/landing/Reveal";

export const metadata = {
  title: "المدونة — متجري",
  description:
    "مقالات قصيرة وعملية لأصحاب المتاجر — قريباً.",
};

export default function BlogPage() {
  return (
    <>
      <PageHeader
        eyebrow="المدونة"
        title="قريباً — مقالات لأصحاب المتاجر"
        lead="شغالين على محتوى عملي قصير: نصائح بيع، إدارة مخزون، تقارير تفهمها بسرعة، وقصص من متاجر حقيقية."
      />

      <section className="py-16 md:py-20">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 text-center">
          <Reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent-light text-accent text-xs font-bold tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              قيد التحضير
            </div>
            <p className="text-text-secondary leading-relaxed mt-6">
              لسه بنحضّر أول مجموعة مقالات. لو حابب نخبرك أول ما ينزل أي محتوى
              جديد، تواصل معنا وهنبعتلك أول ما يبدأ.
            </p>
            <div className="mt-8">
              <Link href="/contact">
                <Button variant="secondary" className="px-6 py-2.5">
                  تواصل معنا
                </Button>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
