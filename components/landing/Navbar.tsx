"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";
import { Menu, X } from "@/lib/icons";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "#features", label: "المميزات" },
  { href: "#how", label: "كيف يعمل" },
  { href: "#cta", label: "ابدأ" },
];

export function LandingNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
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

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-all duration-300",
        scrolled
          ? "bg-white/85 backdrop-blur-md border-b border-border shadow-sm"
          : "bg-transparent",
      )}
    >
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <Link href="/welcome" className="flex items-center" aria-label="متجري">
          <Logo size="sm" />
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-2">
          <Link href="/login">
            <Button variant="secondary">تسجيل الدخول</Button>
          </Link>
          <Link href="/signup">
            <Button>إنشاء حساب</Button>
          </Link>
        </div>

        <button
          type="button"
          className="md:hidden p-2 text-text-primary"
          onClick={() => setOpen((v) => !v)}
          aria-label="القائمة"
          aria-expanded={open}
        >
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </nav>

      {/* Mobile drawer */}
      <div
        className={cn(
          "md:hidden overflow-hidden transition-[max-height] duration-300 bg-white border-b border-border",
          open ? "max-h-96" : "max-h-0",
        )}
      >
        <div className="px-4 py-4 space-y-1">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block py-2.5 text-text-secondary font-medium hover:text-text-primary"
            >
              {l.label}
            </a>
          ))}
          <div className="flex gap-2 pt-3 mt-2 border-t border-border">
            <Link href="/login" className="flex-1" onClick={() => setOpen(false)}>
              <Button variant="secondary" className="w-full">
                تسجيل الدخول
              </Button>
            </Link>
            <Link href="/signup" className="flex-1" onClick={() => setOpen(false)}>
              <Button className="w-full">إنشاء حساب</Button>
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
