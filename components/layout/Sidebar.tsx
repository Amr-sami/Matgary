"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  PanelRightClose,
  PanelRightOpen,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useSettings } from "@/components/settings-context";
import { UserMenu } from "./UserMenu";
import { useSession } from "next-auth/react";
import { can, type Permission } from "@/lib/permissions";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Permission required to see this item. Owner sees everything regardless. */
  requires: Permission;
}

const primaryItems: NavItem[] = [
  { href: "/", label: "لوحة التحكم", icon: LayoutDashboard, requires: "view_dashboard" },
  { href: "/inventory", label: "المخزن", icon: Package, requires: "view_inventory" },
  { href: "/sales", label: "المبيعات", icon: ShoppingCart, requires: "view_sales" },
  { href: "/customers", label: "العملاء", icon: Users, requires: "view_customers" },
  { href: "/expenses", label: "المصاريف", icon: Wallet, requires: "view_expenses" },
];

const secondaryItems: NavItem[] = [
  { href: "/add-product", label: "إضافة صنف", icon: PlusSquare, requires: "manage_inventory" },
  { href: "/suppliers", label: "الموردين", icon: Truck, requires: "view_suppliers" },
  { href: "/purchases", label: "المشتريات", icon: Receipt, requires: "view_purchases" },
  { href: "/returns", label: "المرتجعات", icon: RotateCcw, requires: "view_returns" },
  { href: "/insights", label: "إحصائيات", icon: BarChart3, requires: "view_insights" },
  { href: "/team", label: "الموظفون", icon: UsersGroup, requires: "manage_team" },
  { href: "/settings", label: "الإعدادات", icon: Settings, requires: "view_settings" },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const { settings } = useSettings();
  const { data: session } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const visiblePrimary = primaryItems.filter((i) => can(principal, i.requires));
  const visibleSecondary = secondaryItems.filter((i) => can(principal, i.requires));

  const storeName = settings.shopName?.trim() || "متجري";

  const renderItem = (item: NavItem) => {
    const isActive = pathname === item.href;
    const Icon = item.icon;

    return (
      <Link
        key={item.href}
        href={item.href}
        title={collapsed ? item.label : undefined}
        className={cn(
          "relative flex items-center gap-2.5 h-9 rounded-lg transition-colors mx-2",
          collapsed ? "justify-center px-0" : "px-3",
          isActive
            ? "bg-accent-light text-accent"
            : "text-text-secondary hover:text-text-primary hover:bg-bg-main"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute start-0 top-1.5 bottom-1.5 w-[3px] rounded-full transition-all duration-200",
            isActive ? "bg-accent opacity-100" : "bg-transparent opacity-0"
          )}
        />
        <Icon className={cn("w-4 h-4 shrink-0", isActive && "text-accent")} />
        <span
          className={cn(
            "text-sm font-medium whitespace-nowrap transition-opacity duration-200",
            collapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
          )}
        >
          {item.label}
        </span>
      </Link>
    );
  };

  return (
    <nav className="flex flex-col h-full py-4 relative">
      {/* Collapse toggle */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "توسيع القائمة" : "تصغير القائمة"}
        className="absolute top-6 -end-3 w-6 h-6 rounded-full bg-bg-card border border-border text-text-secondary hover:text-accent hover:border-accent flex items-center justify-center shadow-sm transition-colors z-10"
      >
        {collapsed ? <PanelRightOpen className="w-3.5 h-3.5" /> : <PanelRightClose className="w-3.5 h-3.5" />}
      </button>

      {/* Store name header */}
      <div
        className={cn(
          "mb-3 flex",
          collapsed ? "justify-center px-0" : "px-4"
        )}
        title={collapsed ? storeName : undefined}
      >
        {collapsed ? (
          <span
            aria-label="متجري"
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-accent text-white font-display font-extrabold text-lg leading-none shadow-sm"
          >
            م
          </span>
        ) : (
          <div>
            <h2 className="font-display font-extrabold text-text-primary text-lg truncate leading-tight tracking-tight">
              {storeName}
            </h2>
            <span className="mt-1.5 block h-[3px] w-8 rounded-full bg-accent" />
          </div>
        )}
      </div>

      {/* Primary Nav Links */}
      <div className="mt-2 px-1 space-y-1">{visiblePrimary.map(renderItem)}</div>

      {/* "More" divider — hidden when no secondary items survive permission filter */}
      {visibleSecondary.length > 0 && (
        <div className={cn("mt-6 mb-2", collapsed ? "px-2" : "px-6")}>
          {collapsed ? (
            <div className="h-px bg-border" />
          ) : (
            <p className="text-xs text-text-secondary font-medium">المزيد</p>
          )}
        </div>
      )}

      {/* Secondary Nav Links */}
      <div className="flex-1 px-1 space-y-1">{visibleSecondary.map(renderItem)}</div>

      {/* Footer: user menu + version */}
      <div
        className={cn(
          "border-t border-border pt-2 mt-2 transition-all duration-200",
          collapsed ? "px-1" : "px-2"
        )}
      >
        <UserMenu collapsed={collapsed} />
        <p
          className={cn(
            "text-[10px] text-text-secondary whitespace-nowrap text-center mt-1 mb-1",
            collapsed && "opacity-0"
          )}
        >
          نسخة 1.0.0
        </p>
      </div>
    </nav>
  );
}
