"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Package, ShoppingCart, PlusSquare, RotateCcw, BarChart3, Wallet, Users, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "لوحة التحكم", icon: LayoutDashboard },
  { href: "/inventory", label: "المخزن", icon: Package },
  { href: "/sales", label: "المبيعات", icon: ShoppingCart },
  { href: "/customers", label: "العملاء", icon: Users },
  { href: "/expenses", label: "المصاريف", icon: Wallet },
  { href: "/add-product", label: "إضافة صنف", icon: PlusSquare },
  { href: "/returns", label: "المرتجعات", icon: RotateCcw },
  { href: "/insights", label: "إحصائيات", icon: BarChart3 },
  { href: "/settings", label: "الإعدادات", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col h-full py-6">
      {/* Logo */}
      <div className="px-4 mb-8">
        <h1 className="text-xl font-bold text-white">Corner Store</h1>
        <p className="text-sm text-gray-400">نظام إدارة المخزن</p>
      </div>

      {/* Nav Links */}
      <div className="flex-1 px-2 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg transition-colors mx-2",
                isActive
                  ? "bg-accent/10 text-accent"
                  : "text-gray-400 hover:text-white hover:bg-white/5"
              )}
            >
              <Icon className={cn("w-5 h-5", isActive && "text-accent")} />
              <span className="font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-gray-800">
        <p className="text-xs text-gray-500">نسخة 1.0.0</p>
      </div>
    </nav>
  );
}