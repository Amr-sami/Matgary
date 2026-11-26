"use client";

import { useState, useTransition } from "react";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { startDemoSession } from "@/app/[lang]/(auth)/demo-actions";
import { Zap } from "@/lib/icons";

// Compact pill version of the demo CTA — sits next to <LangSwitcher /> in
// the auth layout's top-end corner instead of underneath the form.
export function DemoLoginPill() {
  const { auth } = useDictionary();
  const t = auth.demo;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const r = await startDemoSession();
      if (!r.ok) {
        setError(r.code === "RATE_LIMITED" ? t.errors.rateLimited : t.errors.unavailable);
        return;
      }
      window.location.href = r.redirectTo;
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-full bg-accent text-white px-3 py-1.5 text-xs font-bold shadow-sm hover:bg-accent/90 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Zap weight="fill" className="size-3.5" />
        <span>{pending ? t.busy : t.cta}</span>
      </button>
      {error && (
        <p className="text-[11px] text-danger bg-white/80 rounded px-2 py-0.5">
          {error}
        </p>
      )}
    </div>
  );
}
