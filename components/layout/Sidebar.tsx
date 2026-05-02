"use client";

import Link from "next/link";
import Image from "next/image";
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
  Settings,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const primaryItems = [
  { href: "/", label: "لوحة التحكم", icon: LayoutDashboard },
  { href: "/inventory", label: "المخزن", icon: Package },
  { href: "/sales", label: "المبيعات", icon: ShoppingCart },
  { href: "/customers", label: "العملاء", icon: Users },
  { href: "/expenses", label: "المصاريف", icon: Wallet },
];

const secondaryItems = [
  { href: "/add-product", label: "إضافة صنف", icon: PlusSquare },
  { href: "/returns", label: "المرتجعات", icon: RotateCcw },
  { href: "/insights", label: "إحصائيات", icon: BarChart3 },
  { href: "/settings", label: "الإعدادات", icon: Settings },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();

  const renderItem = (item: { href: string; label: string; icon: typeof LayoutDashboard }) => {
    const isActive = pathname === item.href;
    const Icon = item.icon;

    return (
      <Link
        key={item.href}
        href={item.href}
        title={collapsed ? item.label : undefined}
        className={cn(
          "flex items-center gap-3 h-11 rounded-lg transition-colors mx-2",
          collapsed ? "justify-center px-0" : "px-4",
          isActive
            ? "bg-accent-light text-accent"
            : "text-text-secondary hover:text-text-primary hover:bg-bg-main"
        )}
      >
        <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-accent")} />
        <span
          className={cn(
            "font-medium whitespace-nowrap transition-opacity duration-200",
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

      {/* Logo */}
      <div className={cn("mb-6 flex items-center gap-2", collapsed ? "justify-center px-2" : "px-4")}>
        <Image src="/logo.png" alt="Corner Store" width={32} height={32} className="rounded-md shrink-0" />
        <div
          className={cn(
            "transition-opacity duration-200 overflow-hidden",
            collapsed ? "opacity-0 w-0" : "opacity-100"
          )}
        >
          <h1 className="text-lg font-bold text-text-primary leading-tight whitespace-nowrap">Corner Store</h1>
          <p className="text-xs text-text-secondary whitespace-nowrap">نظام إدارة المخزن</p>
        </div>
      </div>

      {/* Primary Nav Links */}
      <div className="px-1 space-y-1">{primaryItems.map(renderItem)}</div>

      {/* "More" divider */}
      <div className={cn("mt-6 mb-2", collapsed ? "px-2" : "px-6")}>
        {collapsed ? (
          <div className="h-px bg-border" />
        ) : (
          <p className="text-xs text-text-secondary font-medium">المزيد</p>
        )}
      </div>

      {/* Secondary Nav Links */}
      <div className="flex-1 px-1 space-y-1">{secondaryItems.map(renderItem)}</div>

      {/* Footer */}
      <div
        className={cn(
          "py-3 border-t border-border transition-all duration-200",
          collapsed ? "px-2 text-center" : "px-4"
        )}
      >
        <p className="text-xs text-text-secondary whitespace-nowrap">{collapsed ? "v1.0" : "نسخة 1.0.0"}</p>
      </div>
    </nav>
  );
}
