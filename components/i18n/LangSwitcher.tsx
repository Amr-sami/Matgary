"use client";

import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { Globe } from "@/lib/icons";
import { LOCALE_COOKIE, locales, type Locale } from "@/lib/i18n/config";
import { useLocale } from "./DictionaryProvider";
import { cn } from "@/lib/utils";

const LABEL: Record<Locale, string> = {
  ar: "العربية",
  en: "English",
};

const SHORT: Record<Locale, string> = {
  ar: "ع",
  en: "EN",
};

interface Props {
  /** Visual variant. `compact` = icon + short label (default). `bare` = icon only. */
  variant?: "compact" | "bare";
  className?: string;
}

export function LangSwitcher({ variant = "compact", className }: Props) {
  const pathname = usePathname();
  const active = useLocale();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function switchTo(target: Locale) {
    if (target === active) {
      setOpen(false);
      return;
    }
    document.cookie = `${LOCALE_COOKIE}=${target}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    const segs = pathname.split("/");
    let nextPath: string;
    if (segs[1] === active) {
      segs[1] = target;
      nextPath = segs.join("/") || `/${target}`;
    } else {
      nextPath = `/${target}${pathname}`;
    }
    // Hard navigation, not router.replace(). Root layout reads `x-locale`
    // and sets <html dir> on render; soft navigations don't re-execute
    // the root layout, so `<html dir>` would stay stale after a switch.
    window.location.assign(nextPath);
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={LABEL[active]}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full text-text-secondary hover:text-text-primary hover:bg-bg-main/60 transition-colors",
          variant === "compact" ? "px-2.5 h-9 text-sm font-medium" : "w-9 h-9 justify-center",
        )}
      >
        <Globe className="w-[18px] h-[18px]" />
        {variant === "compact" && <span>{SHORT[active]}</span>}
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute end-0 mt-2 min-w-[160px] rounded-xl border border-border bg-white shadow-lg overflow-hidden z-50"
        >
          {locales.map((loc) => (
            <li key={loc}>
              <button
                type="button"
                role="option"
                aria-selected={loc === active}
                onClick={() => switchTo(loc)}
                className={cn(
                  "w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm text-start hover:bg-bg-main transition-colors",
                  loc === active && "font-bold text-accent",
                )}
              >
                <span>{LABEL[loc]}</span>
                <span className="text-xs text-text-secondary">{SHORT[loc]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
