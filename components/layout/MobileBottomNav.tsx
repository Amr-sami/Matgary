"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useSession } from "next-auth/react";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  PlusSquare,
  RotateCcw,
  BarChart3,
  Wallet,
  Users,
  UsersGroup,
  Settings,
  Menu,
  LogOut,
  X,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/(auth)/actions";
import { can, type Permission } from "@/lib/permissions";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  requires: Permission;
}

const primaryItems: NavItem[] = [
  { href: "/", label: "لوحة", icon: LayoutDashboard, requires: "view_dashboard" },
  { href: "/inventory", label: "المخزن", icon: Package, requires: "view_inventory" },
  { href: "/sales", label: "المبيعات", icon: ShoppingCart, requires: "view_sales" },
  { href: "/add-product", label: "إضافة", icon: PlusSquare, requires: "manage_inventory" },
  { href: "/customers", label: "العملاء", icon: Users, requires: "view_customers" },
];

const moreItems: NavItem[] = [
  { href: "/expenses", label: "المصاريف", icon: Wallet, requires: "view_expenses" },
  { href: "/returns", label: "المرتجعات", icon: RotateCcw, requires: "view_returns" },
  { href: "/insights", label: "إحصائيات", icon: BarChart3, requires: "view_insights" },
  { href: "/team", label: "الموظفون", icon: UsersGroup, requires: "manage_team" },
  { href: "/settings", label: "الإعدادات", icon: Settings, requires: "view_settings" },
];

export function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const visiblePrimary = primaryItems.filter((i) => can(principal, i.requires));
  const visibleMore = moreItems.filter((i) => can(principal, i.requires));
  const [isSigningOut, startSignOut] = useTransition();
  const email = session?.user?.email ?? "";

  const handleSignOut = () => {
    startSignOut(async () => {
      try {
        window.localStorage.removeItem("shop:settings:v1");
      } catch {}
      await logoutAction();
    });
  };

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

  const moreActive = visibleMore.some((i) => i.href === pathname);

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
        <div className="grid grid-cols-3 gap-2">
          {visibleMore.map((item) => {
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

        {email && (
          <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
            <p className="text-xs text-text-secondary truncate">{email}</p>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="flex items-center gap-1.5 text-xs font-medium text-danger hover:bg-danger-light rounded-lg px-3 py-1.5 disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              {isSigningOut ? "…" : "تسجيل الخروج"}
            </button>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <nav className="flex items-stretch justify-around bg-bg-card border-t border-border px-1 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]">
        {visiblePrimary.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex flex-col items-center justify-center gap-0.5 px-1 py-1 rounded-lg flex-1 min-w-[48px]",
                isActive ? "text-accent" : "text-text-secondary"
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] leading-tight whitespace-nowrap">{item.label}</span>
              <span
                aria-hidden
                className={cn(
                  "absolute -bottom-1 h-[3px] w-7 rounded-full transition-all duration-200",
                  isActive ? "bg-accent opacity-100" : "bg-transparent opacity-0"
                )}
              />
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-label="المزيد"
          aria-expanded={moreOpen}
          className={cn(
            "relative flex flex-col items-center justify-center gap-0.5 px-1 py-1 rounded-lg flex-1 min-w-[48px] transition-colors",
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
          <span
            aria-hidden
            className={cn(
              "absolute -bottom-1 h-[3px] w-7 rounded-full transition-all duration-200",
              moreActive || moreOpen ? "bg-accent opacity-100" : "bg-transparent opacity-0"
            )}
          />
        </button>
      </nav>
    </>
  );
}
