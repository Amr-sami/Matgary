"use client";

import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { Reveal } from "./Reveal";

export function Features() {
  const dict = useDictionary();
  const f = dict.features;
  return (
    <section id="features" className="relative py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <Reveal>
          <div className="max-w-2xl mb-14">
            <span className="font-catchy inline-block text-accent text-base font-bold mb-3 tracking-wide">
              {f.eyebrow}
            </span>
            <h2 className="font-display font-black text-3xl md:text-4xl text-text-primary leading-tight tracking-tight">
              {f.title}
            </h2>
            <p className="text-text-secondary mt-4 leading-relaxed max-w-xl">
              {f.body}
            </p>
          </div>
        </Reveal>

        {/* Bento — 3 cols, 2 rows, alternating big/small for an editorial rhythm */}
        <div className="grid md:grid-cols-3 gap-4 md:gap-5">
          {/* Row 1, big-left */}
          <Reveal className="md:col-span-2" delay={0}>
            <FeatureCard
              eyebrow={f.team.eyebrow}
              title={f.team.title}
              body={f.team.body}
            >
              <TeamMock />
            </FeatureCard>
          </Reveal>

          {/* Row 1, small-right */}
          <Reveal delay={100}>
            <FeatureCard
              eyebrow={f.unlimited.eyebrow}
              title={f.unlimited.title}
              body={f.unlimited.body}
            >
              <InfinityMock />
            </FeatureCard>
          </Reveal>

          {/* Row 2, small-left */}
          <Reveal delay={200}>
            <FeatureCard
              eyebrow={f.whatsapp.eyebrow}
              title={f.whatsapp.title}
              body={f.whatsapp.body}
            >
              <ChatMock />
            </FeatureCard>
          </Reveal>

          {/* Row 2, big-right */}
          <Reveal className="md:col-span-2" delay={300}>
            <FeatureCard
              eyebrow={f.customers.eyebrow}
              title={f.customers.title}
              body={f.customers.body}
            >
              <CustomersMock />
            </FeatureCard>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

interface FeatureCardProps {
  eyebrow: string;
  title: string;
  body: string;
  children: React.ReactNode;
}

function FeatureCard({ eyebrow, title, body, children }: FeatureCardProps) {
  return (
    <article className="relative h-full bg-white border border-border rounded-2xl p-6 md:p-7 overflow-hidden flex flex-col">
      <div className="space-y-2">
        <span className="text-[11px] font-bold text-accent uppercase tracking-[0.18em]">
          {eyebrow}
        </span>
        <h3 className="font-display font-bold text-xl md:text-[22px] text-text-primary leading-snug">
          {title}
        </h3>
        <p className="text-sm text-text-secondary leading-relaxed">{body}</p>
      </div>
      <div className="mt-6 flex-1 flex items-end">
        <div className="w-full">{children}</div>
      </div>
    </article>
  );
}

/* ─── Visual mocks ─────────── */

function TeamMock() {
  const { features } = useDictionary();
  const m = features.team.members;
  const rows = [
    { ...m.manager, roleColor: "bg-accent text-white" },
    { ...m.cashier, roleColor: "bg-accent-light text-accent" },
    { ...m.warehouse, roleColor: "bg-bg-main text-text-secondary" },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div
          key={r.name}
          className="flex items-center gap-3 bg-bg-main/70 rounded-lg p-2.5 border border-border"
        >
          <div className="w-8 h-8 rounded-full bg-white border border-border flex items-center justify-center font-bold text-sm text-text-primary">
            {r.initial}
          </div>
          <div className="flex-1 text-sm font-medium text-text-primary">
            {r.name}
          </div>
          <span
            className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${r.roleColor}`}
          >
            {r.role}
          </span>
        </div>
      ))}
    </div>
  );
}

function InfinityMock() {
  return (
    <div className="relative h-28 flex items-center justify-center overflow-hidden">
      <span
        aria-hidden
        className="font-display font-black text-[12rem] text-accent leading-none select-none -mb-6"
        style={{ letterSpacing: "-0.05em" }}
      >
        ∞
      </span>
      <span
        aria-hidden
        className="absolute inset-0 -z-10 rounded-full blur-3xl opacity-40"
        style={{
          background:
            "radial-gradient(circle, rgba(18,3,227,0.2) 0%, transparent 70%)",
        }}
      />
    </div>
  );
}

function ChatMock() {
  const { features } = useDictionary();
  return (
    <div className="space-y-2">
      <div className="flex justify-start">
        <div
          className="bg-bg-main rounded-2xl rounded-bs-sm px-3.5 py-2.5 max-w-[90%]"
          style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
        >
          <p className="text-xs text-text-primary leading-snug">
            {features.whatsapp.saleReceiptLine}
          </p>
          <p
            dir="ltr"
            className="text-[10px] text-text-secondary mt-0.5 font-mono"
          >
            12:45 PM ✓✓
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <div
          className="bg-accent text-white rounded-2xl rounded-be-sm px-3.5 py-2.5 max-w-[80%]"
          style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.06)" }}
        >
          <p className="text-xs leading-snug">{features.whatsapp.thanks}</p>
        </div>
      </div>
    </div>
  );
}

function CustomersMock() {
  const { features } = useDictionary();
  return (
    <div className="space-y-2">
      {features.customers.rows.map((c, i) => {
        const inactive = i === features.customers.rows.length - 1;
        return (
          <div
            key={c.name}
            className="flex items-center gap-3 bg-bg-main/70 rounded-lg p-2.5 border border-border"
          >
            <div className="w-8 h-8 rounded-full bg-white border border-border flex items-center justify-center font-bold text-sm text-text-primary">
              {c.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {c.name}
              </p>
              <p className="text-[10px] text-text-secondary mt-0.5">{c.spend}</p>
            </div>
            <span
              className={`text-[10px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${
                inactive
                  ? "bg-danger-light text-danger"
                  : "bg-bg-main text-text-secondary"
              }`}
            >
              {c.last}
            </span>
          </div>
        );
      })}
    </div>
  );
}
