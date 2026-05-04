import { Reveal } from "./Reveal";

const STEPS = [
  {
    n: "1",
    title: "أنشئ حسابك",
    body: "تسجيل سريع — اسم المتجر، بريدك، كلمة سر. خلال أقل من دقيقة.",
  },
  {
    n: "2",
    title: "أضف منتجاتك",
    body: "استورد قائمة المنتجات بالـCSV أو أضفها يدوياً مع الأصناف والأسعار.",
  },
  {
    n: "3",
    title: "ابدأ البيع",
    body: "افتح نقطة البيع وسجل أول عملية. يحدّث المخزون والتقارير تلقائياً.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="relative py-20 md:py-28 bg-bg-card border-y border-border"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div className="max-w-2xl mx-auto text-center mb-14">
            <span className="font-catchy inline-block text-accent text-base font-bold mb-3 tracking-wide">
              كيف يعمل
            </span>
            <h2 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
              من الحساب الجديد إلى أول عملية بيع
            </h2>
            <p className="text-text-secondary mt-4 leading-relaxed">
              ثلاث خطوات سهلة فقط — وأنت جاهز لإدارة متجرك من أي جهاز.
            </p>
          </div>
        </Reveal>

        <div className="relative grid md:grid-cols-3 gap-8">
          {/* Connecting line on desktop */}
          <div
            aria-hidden
            className="hidden md:block absolute top-10 start-[16%] end-[16%] h-px bg-gradient-to-l from-accent/20 via-accent/40 to-accent/20"
          />

          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 120}>
              <div className="relative text-center">
                <div className="relative inline-flex items-center justify-center w-20 h-20 rounded-full bg-white border-2 border-accent text-accent font-display font-black text-3xl shadow-md mb-5">
                  {s.n}
                  <span
                    aria-hidden
                    className="absolute -inset-2 rounded-full border border-accent/20"
                  />
                </div>
                <h3 className="font-display font-bold text-xl text-text-primary mb-2">
                  {s.title}
                </h3>
                <p className="text-text-secondary text-sm leading-relaxed max-w-xs mx-auto">
                  {s.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
