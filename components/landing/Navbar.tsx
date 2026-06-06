"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { ChevronLeft } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { LangSwitcher } from "@/components/i18n/LangSwitcher";

export function LandingNavbar() {
  const dict = useDictionary();
  const locale = useLocale();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  const NAV_LINKS = [
    { href: "#features", label: dict.nav.features },
    { href: "#how", label: dict.nav.how },
    { href: "#pricing", label: dict.nav.pricing },
  ];

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close mobile drawer when window crosses md breakpoint up.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 768) setOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,backdrop-filter,border-color] duration-300",
        scrolled || open
          ? "bg-white/85 backdrop-blur-md border-b border-border"
          : "bg-transparent border-b border-transparent",
      )}
    >
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <Link
          href={`/${locale}/welcome`}
          className="flex items-center shrink-0"
          aria-label={dict.common.brand}
        >
          <Logo size="sm" />
        </Link>

        <div className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="group relative px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              {l.label}
              <span
                aria-hidden
                className="absolute inset-x-3 -bottom-0.5 h-[2px] origin-[100%_50%] scale-x-0 bg-accent rounded-full transition-transform duration-300 group-hover:scale-x-100"
              />
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-1">
          <LangSwitcher className="me-1" />
          <Link
            href={`/${locale}/login`}
            className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            {dict.common.signIn}
          </Link>
          <span aria-hidden className="mx-1 h-5 w-px bg-border" />
          <Link href={`/${locale}/signup`}>
            <Button className="group gap-1.5 px-4 py-2 text-sm">
              <span>{dict.common.startFree}</span>
              <ChevronLeft className="w-4 h-4 transition-transform duration-200 group-hover:-translate-x-0.5 rtl:rotate-0 ltr:rotate-180" />
            </Button>
          </Link>
        </div>

        <div className="md:hidden flex items-center gap-1">
          <LangSwitcher variant="bare" />
          <button
            type="button"
            className="relative w-10 h-10 -me-2 inline-flex items-center justify-center text-text-primary"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? dict.common.closeMenu : dict.common.openMenu}
            aria-expanded={open}
          >
            <span className="sr-only">{dict.common.menu}</span>
            <span aria-hidden className="relative block w-5 h-4">
              <span
                className={cn(
                  "absolute left-0 right-0 h-[2px] bg-current rounded-full transition-all duration-300",
                  open ? "top-1/2 -translate-y-1/2 rotate-45" : "top-0",
                )}
              />
              <span
                className={cn(
                  "absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-current rounded-full transition-opacity duration-200",
                  open ? "opacity-0" : "opacity-100",
                )}
              />
              <span
                className={cn(
                  "absolute left-0 right-0 h-[2px] bg-current rounded-full transition-all duration-300",
                  open
                    ? "bottom-1/2 translate-y-1/2 -rotate-45"
                    : "bottom-0",
                )}
              />
            </span>
          </button>
        </div>
      </nav>

      {/* Mobile scrim */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={cn(
          "md:hidden fixed inset-x-0 top-16 bottom-0 bg-text-primary/30 backdrop-blur-[2px] transition-opacity duration-300",
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none",
        )}
      />

      {/* Mobile drawer */}
      <div
        className={cn(
          "md:hidden absolute inset-x-0 top-full bg-white border-b border-border shadow-lg overflow-hidden transition-[max-height,opacity] duration-300 ease-out",
          open ? "max-h-[80vh] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="px-4 py-3">
          <ul className="py-1">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between py-3.5 text-text-primary font-medium border-b border-border/60 last:border-0"
                >
                  <span>{l.label}</span>
                  <ChevronLeft className="w-4 h-4 text-text-secondary" />
                </a>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-2 pt-4 mt-2 border-t border-border">
            <Link href={`/${locale}/login`} onClick={() => setOpen(false)}>
              <Button variant="secondary" className="w-full py-2.5">
                {dict.common.signIn}
              </Button>
            </Link>
            <Link href={`/${locale}/signup`} onClick={() => setOpen(false)}>
              <Button className="w-full py-2.5 gap-1.5">
                <span>{dict.common.startFree}</span>
                <ChevronLeft className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
