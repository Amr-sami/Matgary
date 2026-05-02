"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  PlusSquare,
  RotateCcw,
  BarChart3,
  Wallet,
  Users,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const primaryItems = [
  { href: "/", label: "لوحة", icon: LayoutDashboard },
  { href: "/inventory", label: "المخزن", icon: Package },
  { href: "/sales", label: "المبيعات", icon: ShoppingCart },
  { href: "/add-product", label: "إضافة", icon: PlusSquare },
  { href: "/customers", label: "العملاء", icon: Users },
];

const moreItems = [
  { href: "/expenses", label: "المصاريف", icon: Wallet },
  { href: "/returns", label: "المرتجعات", icon: RotateCcw },
  { href: "/insights", label: "إحصائيات", icon: BarChart3 },
  { href: "/settings", label: "الإعدادات", icon: Settings },
];

export function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [moreOpen]);

  const moreActive = moreItems.some((i) => i.href === pathname);

  return (
    <>
      {/* Backdrop + slide-up sheet */}
      <div
        onClick={() => setMoreOpen(false)}
        className={cn(
          "fixed inset-0 bg-black/40 transition-opacity duration-200 z-40",
          moreOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-hidden={!moreOpen}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 bg-bg-card rounded-t-2xl shadow-[0_-8px_24px_rgba(0,0,0,0.12)] pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 px-4 transition-transform duration-300 ease-out",
          moreOpen ? "translate-y-0" : "translate-y-full"
        )}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">المزيد</h3>
          <button
            type="button"
            onClick={() => setMoreOpen(false)}
            aria-label="إغلاق"
            className="w-8 h-8 rounded-full flex items-center justify-center text-text-secondary hover:bg-bg-main"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {moreItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex flex-col items-center gap-1 py-3 rounded-xl transition-colors",
                  isActive
                    ? "bg-accent-light text-accent"
                    : "text-text-secondary hover:bg-bg-main"
                )}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[11px] font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Bottom bar */}
      <nav className="flex items-stretch justify-around bg-bg-card border-t border-border px-1 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]">
        {primaryItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 px-1 py-1 rounded-lg flex-1 min-w-[48px]",
                isActive ? "text-accent" : "text-text-secondary"
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] leading-tight whitespace-nowrap">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-label="المزيد"
          aria-expanded={moreOpen}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 px-1 py-1 rounded-lg flex-1 min-w-[48px] transition-colors",
            moreActive || moreOpen ? "text-accent" : "text-text-secondary"
          )}
        >
          <span className="relative w-5 h-5">
            <Menu
              className={cn(
                "absolute inset-0 w-5 h-5 transition-all duration-200",
                moreOpen ? "opacity-0 rotate-90 scale-75" : "opacity-100 rotate-0 scale-100"
              )}
            />
            <X
              className={cn(
                "absolute inset-0 w-5 h-5 transition-all duration-200",
                moreOpen ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-75"
              )}
            />
          </span>
          <span className="text-[10px] leading-tight whitespace-nowrap">المزيد</span>
        </button>
      </nav>
    </>
  );
}
