"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Package, ShoppingCart, PlusSquare, RotateCcw, BarChart3, Wallet, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "لوحة", icon: LayoutDashboard },
  { href: "/inventory", label: "المخزن", icon: Package },
  { href: "/sales", label: "المبيعات", icon: ShoppingCart },
  { href: "/customers", label: "العملاء", icon: Users },
  { href: "/add-product", label: "إضافة", icon: PlusSquare },
  { href: "/returns", label: "مرتجعات", icon: RotateCcw },
  { href: "/expenses", label: "المصاريف", icon: Wallet },
  { href: "/insights", label: "إحصائيات", icon: BarChart3 },
];

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center justify-between bg-white border-t border-border px-1 py-2 overflow-x-auto">
      {navItems.map((item) => {
        const isActive = pathname === item.href;
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-col items-center gap-0.5 px-1 py-1 rounded-lg flex-1 min-w-[48px]",
              isActive ? "text-accent" : "text-text-secondary"
            )}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] leading-tight whitespace-nowrap">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
