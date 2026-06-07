"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Check, DollarSign, Globe, LogOut, ShieldCheck } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/[lang]/(auth)/actions";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import type { Locale } from "@/lib/i18n/config";

interface Props {
  collapsed: boolean;
}

export function UserMenu({ collapsed }: Props) {
  const { data: session } = useSession();
  const dict = useDictionary();
  const activeLocale = useLocale();
  const t = dict.app.shell.userMenu;
  const langT = dict.app.shell.language;
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [switching, setSwitching] = useState<Locale | null>(null);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setLangOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const email = session?.user?.email ?? "";
  const initial = (session?.user?.name?.charAt(0) || email.charAt(0) || "?").toUpperCase();

  const signOut = () => {
    startTransition(async () => {
      try {
        window.localStorage.removeItem("shop:settings:v1");
      } catch {}
      await logoutAction();
    });
  };

  const switchTo = async (target: Locale) => {
    if (target === activeLocale || switching) return;
    setSwitching(target);
    try {
      const res = await fetch("/api/account/locale", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
      if (!res.ok) {
        setSwitching(null);
        return;
      }
      // Full reload so the root layout + every RSC re-renders with the new
      // locale + dictionary + <html lang/dir>. Soft nav would leave the
      // shell in the old language until the next hard refresh.
      window.location.reload();
    } catch {
      setSwitching(null);
    }
  };

  const LANG_OPTIONS: { code: Locale; label: string }[] = [
    { code: "ar", label: langT.arabic },
    { code: "en", label: langT.english },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? email : undefined}
        className={cn(
          "w-full flex items-center gap-2 rounded-lg p-2 hover:bg-bg-main transition-colors",
          collapsed && "justify-center",
        )}
      >
        <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center font-bold text-sm shrink-0">
          {initial}
        </div>
        <span
          dir="ltr"
          className={cn(
            "text-xs text-text-secondary truncate text-start flex-1",
            collapsed && "hidden",
          )}
        >
          {email}
        </span>
      </button>

      {open && (
        <div
          className={cn(
            "absolute bottom-full mb-2 bg-bg-card border border-border rounded-xl shadow-lg overflow-hidden z-50",
            collapsed ? "start-full ms-2 w-56" : "inset-x-0",
          )}
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs text-text-secondary">{t.signedInAs}</p>
            <p dir="ltr" className="text-sm font-medium text-text-primary truncate">
              {email}
            </p>
          </div>

          {session?.user?.role === "owner" && (
            <Link
              href="/billing"
              onClick={() => setOpen(false)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-main hover:text-text-primary transition-colors"
            >
              <DollarSign className="w-4 h-4" />
              {t.subscription}
            </Link>
          )}
          <Link
            href="/account/security"
            onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-main hover:text-text-primary transition-colors"
          >
            <ShieldCheck className="w-4 h-4" />
            {t.security}
          </Link>

          {/* Language switcher — expand-on-click sub-row so the popover stays
              compact. PATCH /api/account/locale → cache-bust → reload. */}
          <button
            type="button"
            onClick={() => setLangOpen((v) => !v)}
            disabled={!!switching}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-main hover:text-text-primary transition-colors disabled:opacity-60"
          >
            <Globe className="w-4 h-4" />
            <span className="flex-1 text-start">{t.language}</span>
            <span className="text-xs text-text-secondary">
              {activeLocale === "ar" ? langT.arabic : langT.english}
            </span>
          </button>
          {langOpen && (
            <div className="bg-bg-main border-t border-border">
              {LANG_OPTIONS.map((opt) => {
                const isActive = opt.code === activeLocale;
                const isSwitching = switching === opt.code;
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => switchTo(opt.code)}
                    disabled={!!switching || isActive}
                    className={cn(
                      "w-full flex items-center gap-2 px-6 py-2 text-sm transition-colors",
                      isActive
                        ? "text-accent font-medium"
                        : "text-text-secondary hover:bg-bg-card hover:text-text-primary",
                      switching && !isSwitching && "opacity-50",
                    )}
                  >
                    <span className="flex-1 text-start">{opt.label}</span>
                    {isActive && <Check className="w-3.5 h-3.5" />}
                    {isSwitching && (
                      <span className="text-xs">{langT.switching}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={signOut}
            disabled={isPending}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-50 transition-colors border-t border-border"
          >
            <LogOut className="w-4 h-4" />
            {isPending ? t.signingOut : t.signOut}
          </button>
        </div>
      )}
    </div>
  );
}
