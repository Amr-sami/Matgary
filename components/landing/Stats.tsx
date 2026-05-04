import { Reveal } from "./Reveal";

const STATS = [
  { value: "‎99.9%", label: "وقت التشغيل" },
  { value: "‎<1s", label: "زمن تسجيل البيع" },
  { value: "‎24/7", label: "دعم بالعربية" },
  { value: "‎ ∞ ", label: "أصناف بدون حد" },
];

export function Stats() {
  return (
    <section className="py-12 md:py-16 border-y border-border bg-bg-card/60">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 70}>
              <div className="text-center">
                <p
                  dir="ltr"
                  className="font-display font-black text-3xl md:text-4xl text-accent leading-none tracking-tight"
                >
                  {s.value}
                </p>
                <p className="text-xs md:text-sm text-text-secondary mt-2">
                  {s.label}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
