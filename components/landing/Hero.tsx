import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Reveal } from "./Reveal";

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-10 pb-20 md:pt-16 md:pb-28">
      {/* Soft brand glow behind the illustration column */}
      <div
        aria-hidden
        className="absolute -z-10 top-32 -end-20 w-[420px] h-[420px] rounded-full pointer-events-none hidden md:block"
        style={{
          background:
            "radial-gradient(circle, rgba(18,3,227,0.10) 0%, transparent 65%)",
        }}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 grid md:grid-cols-2 gap-10 md:gap-16 items-center">
        <Reveal>
          <div className="space-y-6 text-center md:text-start">
            <h1 className="font-display font-black text-4xl sm:text-5xl lg:text-[58px] text-text-primary leading-[1.05] tracking-tight">
              نقطة بيع، مخزون، تقارير
              <br />
              <span className="relative inline-block">
                <span className="font-catchy text-accent relative z-10">
                  في مكان واحد
                </span>
                <svg
                  viewBox="0 0 280 28"
                  preserveAspectRatio="none"
                  aria-hidden
                  className="absolute -bottom-2 sm:-bottom-3 start-[-6%] w-[112%] h-3 sm:h-4 pointer-events-none select-none"
                >
                  <path
                    d="M8,17 C 45,9 95,19 145,13 C 185,8 225,16 272,13 C 268,21 235,25 195,22 C 145,18 95,24 45,22 C 22,21 10,20 8,17 Z"
                    fill="#1203E3"
                    fillOpacity="0.28"
                  />
                  <path
                    d="M14,17 C 55,11 110,18 160,14 C 200,11 235,16 266,15"
                    stroke="#1203E3"
                    strokeWidth="7"
                    strokeLinecap="round"
                    fill="none"
                    opacity="0.9"
                  />
                  <path
                    d="M22,20 C 70,16 120,21 170,17 C 210,14 245,17 260,17"
                    stroke="#1203E3"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    fill="none"
                    opacity="0.55"
                  />
                </svg>
              </span>
            </h1>
            <p className="text-lg text-text-secondary leading-relaxed max-w-lg mx-auto md:mx-0">
              متجري نظام موحد لإدارة كل ما يحتاجه متجرك يومياً — من المبيعات
              والمخزون إلى الموظفين والتقارير اللحظية.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center md:justify-start gap-3 pt-2">
              <Link href="/signup">
                <Button className="px-7 py-3 text-base w-full sm:w-auto">
                  ابدأ مجاناً
                </Button>
              </Link>
              <Link href="/login">
                <Button
                  variant="secondary"
                  className="px-7 py-3 text-base w-full sm:w-auto"
                >
                  تسجيل الدخول
                </Button>
              </Link>
            </div>
            <div className="flex items-center justify-center md:justify-start gap-6 pt-4 text-xs text-text-secondary">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                مجاناً للبدء
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                بدون بطاقة ائتمان
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                دعم متخصص
              </span>
            </div>
          </div>
        </Reveal>

        <Reveal delay={150}>
          <div className="relative">
            <Image
              src="/market-launch.svg"
              alt="إطلاق متجرك"
              width={560}
              height={400}
              priority
              className="w-full h-auto select-none drop-shadow-sm"
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
