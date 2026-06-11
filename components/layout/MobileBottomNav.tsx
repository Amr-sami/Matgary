"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
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
  Truck,
  Receipt,
  ListChecks,
  DollarSign,
  Menu,
  LogOut,
  Globe,
  X,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/[lang]/(auth)/actions";
import { can, canAny, type Permission } from "@/lib/permissions";
import { useUnreadTaskCount } from "@/hooks/useUnreadTaskCount";
import { useLeaveUnread } from "@/hooks/useLeaveUnread";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import type { Locale } from "@/lib/i18n/config";

interface NavItem {
  href: string;
  /** Key into the dictionary's `app.shell.primary` or `secondary` namespace. */
  labelKey: string;
  icon: typeof LayoutDashboard;
  requires: Permission;
}

const primaryItems: NavItem[] = [
  // Mobile uses the SHORT label for "/" since vertical space is tight.
  { href: "/", labelKey: "dashboardShort", icon: LayoutDashboard, requires: "view_dashboard" },
  { href: "/inventory", labelKey: "inventory", icon: Package, requires: "view_inventory" },
  { href: "/sales", labelKey: "sales", icon: ShoppingCart, requires: "view_sales" },
  { href: "/add-product", labelKey: "addProduct", icon: PlusSquare, requires: "manage_inventory" },
  { href: "/purchases", labelKey: "purchases", icon: Receipt, requires: "view_purchases" },
  { href: "/insights", labelKey: "insights", icon: BarChart3, requires: "view_insights" },
];

const moreItems: NavItem[] = [
  { href: "/tasks", labelKey: "tasks", icon: ListChecks, requires: "view_dashboard" },
  { href: "/customers", labelKey: "customers", icon: Users, requires: "view_customers" },
  { href: "/expenses", labelKey: "expenses", icon: Wallet, requires: "view_expenses" },
  { href: "/cash-shifts", labelKey: "cashShifts", icon: DollarSign, requires: "manage_cash_reconciliation" },
  { href: "/suppliers", labelKey: "suppliers", icon: Truck, requires: "view_suppliers" },
  { href: "/returns", labelKey: "returns", icon: RotateCcw, requires: "view_returns" },
  { href: "/team", labelKey: "team", icon: UsersGroup, requires: "manage_team" },
  // /activity moved into /settings to keep the More sheet compact.
  { href: "/settings", labelKey: "settings", icon: Settings, requires: "view_settings" },
];

export function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { data: session, update: updateSession } = useSession();
  const dict = useDictionary();
  const shellT = dict.app.shell;
  const primaryLabels = shellT.primary as Record<string, string>;
  const secondaryLabels = shellT.secondary as Record<string, string>;
  const labelOf = (item: NavItem): string =>
    primaryLabels[item.labelKey] ?? secondaryLabels[item.labelKey] ?? item.labelKey;
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const visiblePrimary = primaryItems.filter((i) => can(principal, i.requires));
  const visibleMore = moreItems.filter((i) => {
    if (i.href === "/tasks") return !!principal;
    if (i.href === "/team") {
      return canAny(principal, ["manage_team", "request_leave", "manage_leave"]);
    }
    return can(principal, i.requires);
  });
  const [isSigningOut, startSignOut] = useTransition();
  const email = session?.user?.email ?? "";
  const { count: unreadTasks } = useUnreadTaskCount();
  const { counts: leaveUnread } = useLeaveUnread();

  // Language switcher — same PATCH + reload flow as the desktop UserMenu,
  // so behaviour stays identical across surfaces.
  const activeLocale = useLocale();
  const langT = shellT.language;
  const [switchingTo, setSwitchingTo] = useState<Locale | null>(null);
  const switchLocale = async (target: Locale) => {
    if (target === activeLocale || switchingTo) return;
    setSwitchingTo(target);
    try {
      const res = await fetch("/api/account/locale", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: target }),
      });
      if (!res.ok) {
        setSwitchingTo(null);
        return;
      }
      // Force NextAuth to re-encode the JWT cookie with the fresh locale.
      // Without this, window.location.reload() races the cache-bust and the
      // middleware reads the OLD locale from the still-cached JWT cookie —
      // the page renders in the previous language and the user has to
      // switch a second time.
      await updateSession();
      window.location.reload();
    } catch {
      setSwitchingTo(null);
    }
  };

  const badgeFor = (href: string): number | null => {
    if (href === "/tasks" && unreadTasks > 0) return unreadTasks;
    if (href === "/team") {
      const total = leaveUnread.submitted + leaveUnread.decided;
      return total > 0 ? total : null;
    }
    return null;
  };

  const handleSignOut = () => {
    startSignOut(async () => {
      try {
        window.localStorage.removeItem("shop:settings:v1");
        window.localStorage.removeItem("branches:v1");
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

  // Hide-on-scroll-down / show-on-scroll-up — Facebook-style.
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);
  const ticking = useRef(false);
  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      if (ticking.current) return;
      ticking.current = true;
      window.requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - lastY.current;
        if (y < 60) {
          setHidden(false);
        } else if (delta > 8) {
          setHidden(true);
        } else if (delta < -8) {
          setHidden(false);
        }
        lastY.current = y;
        ticking.current = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
          <h3 className="text-sm font-semibold text-text-primary">{shellT.more}</h3>
          <button
            type="button"
            onClick={() => setMoreOpen(false)}
            aria-label={dict.app.common.close}
            className="w-8 h-8 rounded-full flex items-center justify-center text-text-secondary hover:bg-bg-main"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {visibleMore.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            const badge = badgeFor(item.href);
            const label = labelOf(item);
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
                <span className="relative">
                  <Icon className="w-5 h-5" />
                  {badge !== null && (
                    <span className="absolute -top-1.5 -end-2 min-w-[16px] h-[16px] rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center px-1">
                      {badge > 9 ? "9+" : badge}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium">{label}</span>
              </Link>
            );
          })}
        </div>

        {/* Language switcher — inline AR/EN pills. One tap to switch,
            mirrors the desktop UserMenu's behaviour. */}
        <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Globe className="w-4 h-4 text-text-secondary shrink-0" />
            <span className="text-xs font-medium text-text-secondary">
              {langT.label}
            </span>
          </div>
          <div
            role="group"
            aria-label={langT.label}
            className="inline-flex rounded-full border border-border bg-bg-main p-0.5 shrink-0"
          >
            {(["ar", "en"] as Locale[]).map((loc) => {
              const isActive = loc === activeLocale;
              const isSwitching = switchingTo === loc;
              return (
                <button
                  key={loc}
                  type="button"
                  onClick={() => switchLocale(loc)}
                  disabled={!!switchingTo || isActive}
                  aria-pressed={isActive}
                  className={cn(
                    "min-w-[64px] px-3 py-1 text-xs font-semibold rounded-full transition-colors",
                    isActive
                      ? "bg-white text-accent shadow-sm"
                      : "text-text-secondary hover:text-text-primary",
                    switchingTo && !isSwitching && "opacity-50",
                  )}
                >
                  {isSwitching
                    ? langT.switching
                    : loc === "ar"
                      ? langT.arabic
                      : langT.english}
                </button>
              );
            })}
          </div>
        </div>

        {email && (
          <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
            <p dir="ltr" className="text-xs text-text-secondary truncate">{email}</p>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="flex items-center gap-1.5 text-xs font-medium text-danger hover:bg-danger-light rounded-lg px-3 py-1.5 disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              {isSigningOut ? "…" : shellT.userMenu.signOut}
            </button>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <nav
        className={cn(
          "flex items-stretch justify-around bg-bg-card border-t border-border px-1 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]",
          "transition-transform duration-300 ease-out will-change-transform",
          hidden && !moreOpen ? "translate-y-full" : "translate-y-0",
        )}
      >
        {visiblePrimary.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          const badge = badgeFor(item.href);
          const label = labelOf(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex flex-col items-center justify-center gap-0.5 px-1 py-1 rounded-lg flex-1 min-w-[48px]",
                isActive ? "text-accent" : "text-text-secondary"
              )}
            >
              <span className="relative">
                <Icon className="w-5 h-5" />
                {badge !== null && (
                  <span
                    aria-label={`${badge} ${shellT.newItems}`}
                    className="absolute -top-1.5 -end-2 min-w-[16px] h-[16px] rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center px-1"
                  >
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </span>
              <span className="text-[10px] leading-tight whitespace-nowrap">{label}</span>
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
          aria-label={shellT.moreA11y}
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
          <span className="text-[10px] leading-tight whitespace-nowrap">{shellT.more}</span>
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
