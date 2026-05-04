"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, CheckCircle } from "@/lib/icons";
import { Reveal } from "./Reveal";

export function CTASection() {
  return (
    <section id="cta" className="relative py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div
            className="relative overflow-hidden rounded-3xl px-6 py-12 md:px-14 md:py-16"
            style={{
              background:
                "linear-gradient(135deg, #1203E3 0%, #3922F0 55%, #5841F5 100%)",
            }}
          >
            {/* Decorative ambient shapes */}
            <div
              aria-hidden
              className="absolute -top-24 -end-24 w-72 h-72 rounded-full bg-white/10 blur-2xl"
            />
            <div
              aria-hidden
              className="absolute -bottom-32 -start-32 w-80 h-80 rounded-full bg-white/10 blur-2xl"
            />
            <div
              aria-hidden
              className="absolute inset-0 opacity-15"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)",
                backgroundSize: "26px 26px",
              }}
            />

            <div className="relative grid md:grid-cols-[1.15fr_1fr] gap-10 md:gap-12 items-center">
              {/* ── Text column ─────────────────────────────── */}
              <div className="space-y-6 text-center md:text-start">
                <h2 className="font-display font-black text-4xl md:text-5xl lg:text-[58px] text-white leading-[1.05] tracking-tight">
                  انطلق بـ
                  <span className="relative inline-block">
                    <span className="font-catchy text-white relative z-10">
                      متجرك
                    </span>
                    {/* white brush highlight beneath the keyword */}
                    <svg
                      viewBox="0 0 200 28"
                      preserveAspectRatio="none"
                      aria-hidden
                      className="absolute -bottom-1 sm:-bottom-2 start-[-8%] w-[116%] h-3 sm:h-4 pointer-events-none"
                    >
                      <path
                        d="M8,17 C 35,9 75,19 115,13 C 145,8 175,16 192,13 C 188,21 165,25 130,22 C 95,18 55,24 30,22 C 18,21 10,20 8,17 Z"
                        fill="#FFFFFF"
                        fillOpacity="0.28"
                      />
                      <path
                        d="M14,17 C 45,11 85,18 130,14 C 160,11 180,16 188,15"
                        stroke="#FFFFFF"
                        strokeWidth="6"
                        strokeLinecap="round"
                        fill="none"
                        opacity="0.9"
                      />
                    </svg>
                  </span>
                  <br />
                  اليوم.
                </h2>

                <p className="text-white/85 text-lg max-w-md mx-auto md:mx-0 leading-relaxed">
                  إعداد كامل في أقل من دقيقة. مجاناً، بدون التزام.
                </p>

                <div className="flex flex-col sm:flex-row items-center md:items-start justify-center md:justify-start gap-3 pt-2">
                  <Link href="/signup" className="w-full sm:w-auto">
                    <button
                      type="button"
                      className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-accent font-bold text-base shadow-[0_10px_24px_-8px_rgba(0,0,0,0.35)] ring-1 ring-white/40"
                    >
                      <span>إنشاء حساب</span>
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </Link>
                  <Link href="/login" className="w-full sm:w-auto">
                    <button
                      type="button"
                      className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-xl bg-white/10 text-white font-bold text-base ring-1 ring-white/45 backdrop-blur-sm"
                    >
                      لديّ حساب
                    </button>
                  </Link>
                </div>

                <ul className="flex flex-wrap items-center justify-center md:justify-start gap-x-6 gap-y-2 pt-4">
                  {[
                    "بدون بطاقة ائتمان",
                    "إعداد في دقيقة",
                    "إلغاء في أي وقت",
                  ].map((t) => (
                    <li
                      key={t}
                      className="flex items-center gap-1.5 text-white/80 text-xs"
                    >
                      <CheckCircle className="w-3.5 h-3.5 text-white/70" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              {/* ── Illustration column — tilted polaroid card with sticker badge ─── */}
              <div className="relative hidden md:block">
                <div
                  className="relative bg-white rounded-2xl p-6 shadow-2xl"
                  style={{
                    transform: "rotate(2deg)",
                    boxShadow:
                      "0 25px 50px -12px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06)",
                  }}
                >
                  <Image
                    src="/illustrations/landing/groovy.svg"
                    alt=""
                    width={420}
                    height={420}
                    className="w-full h-auto select-none"
                  />
                </div>
                {/* Sticker badge */}
                <div
                  className="absolute -top-3 -end-3 bg-white text-accent font-display font-extrabold text-sm px-4 py-2 rounded-full shadow-xl"
                  style={{ transform: "rotate(-12deg)" }}
                >
                  مجاناً للبدء
                </div>
                {/* Floating dot accents */}
                <span
                  aria-hidden
                  className="absolute -bottom-4 start-8 w-3 h-3 rounded-full bg-white/40"
                />
                <span
                  aria-hidden
                  className="absolute top-6 -start-3 w-2 h-2 rounded-full bg-white/30"
                />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
