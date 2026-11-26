"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Store,
  Receipt,
  UsersGroup,
  Megaphone,
  History,
  TrendingUp,
  User as UserIcon,
  LogOut,
  ShieldCheck,
} from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { LangSwitcher } from "@/components/i18n/LangSwitcher";

interface AdminAccount {
  email: string;
  role: "super_admin" | "ops_admin";
  displayName: string | null;
}

interface AdminShellProps {
  account: AdminAccount;
  children: ReactNode;
}

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /** When true, only super_admin sees the entry. Later specs add entries
   *  that flip this flag (admin mgmt, plan editor, impersonation). */
  superAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/admin/tenants", labelKey: "tenants", icon: Store },
  { href: "/admin/sales", labelKey: "sales", icon: TrendingUp },
  { href: "/admin/plans", labelKey: "plans", icon: Receipt, superAdminOnly: true },
  { href: "/admin/broadcasts", labelKey: "broadcasts", icon: Megaphone, superAdminOnly: true },
  { href: "/admin/admins", labelKey: "admins", icon: UsersGroup, superAdminOnly: true },
  { href: "/admin/audit", labelKey: "audit", icon: History },
  { href: "/admin/account", labelKey: "account", icon: UserIcon },
];

export function AdminShell({ account, children }: AdminShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const dict = useDictionary();
  const t = dict.app.admin.shell;

  const signOut = async () => {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  };

  const signOutEverywhere = async () => {
    if (!window.confirm(t.signOutEverywhereConfirm)) return;
    await fetch("/api/admin/auth/sign-out-everywhere", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  };

  const visibleItems = NAV_ITEMS.filter(
    (i) => !i.superAdminOnly || account.role === "super_admin",
  );

  return (
    <div className="min-h-screen bg-bg-main flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 flex-col bg-bg-card border-e border-border py-4 px-3 gap-1">
        <div className="px-2 mb-4 flex items-start justify-between gap-2">
          <div>
            <p className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-secondary">
              <ShieldCheck className="w-3 h-3" />
              {t.brand}
            </p>
            <h1 className="text-lg font-bold text-text-primary mt-0.5 leading-tight">
              {t.title}
            </h1>
            <span className="mt-1.5 block h-[3px] w-8 rounded-full bg-accent" />
          </div>
          {/* Language toggle — same UX as the tenant app's Header switcher,
              but in cookieOnly mode because /admin/* doesn't carry a
              /[lang] segment. */}
          <LangSwitcher variant="bare" cookieOnly />
        </div>

        <nav className="space-y-1">
          {visibleItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/admin" && pathname.startsWith(item.href));
            const label =
              (t.nav as Record<string, string>)[item.labelKey] ?? item.labelKey;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-accent-light text-accent"
                    : "text-text-secondary hover:bg-bg-main hover:text-text-primary"
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute start-0 top-1.5 bottom-1.5 w-[3px] rounded-full transition-all ${
                    isActive ? "bg-accent opacity-100" : "bg-transparent opacity-0"
                  }`}
                />
                <Icon className="w-4 h-4 shrink-0" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-border pt-3 px-2 space-y-1">
          <p className="text-xs text-text-primary truncate" dir="ltr">
            {account.email}
          </p>
          <p className="text-[10px] text-text-secondary">
            {account.role === "super_admin" ? t.roleSuper : t.roleOps}
          </p>
          <button
            type="button"
            onClick={signOut}
            className="w-full mt-2 inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t.signOut}
          </button>
          <button
            type="button"
            onClick={signOutEverywhere}
            className="w-full inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-danger"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t.signOutEverywhere}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile header */}
        <header className="md:hidden bg-bg-card border-b border-border px-4 py-3 flex items-center justify-between">
          <div>
            <p className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-secondary">
              <ShieldCheck className="w-3 h-3" />
              {t.brand}
            </p>
            <h1 className="text-base font-bold leading-tight">{t.title}</h1>
          </div>
          <div className="flex items-center gap-1">
            <LangSwitcher variant="bare" cookieOnly />
            <button
              type="button"
              onClick={signOut}
              aria-label={t.signOut}
              className="w-9 h-9 inline-flex items-center justify-center rounded-full text-text-secondary hover:text-accent hover:bg-bg-main/60"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mobile nav strip */}
        <nav className="md:hidden bg-bg-card border-b border-border px-2 py-2 flex gap-1 overflow-x-auto">
          {visibleItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/admin" && pathname.startsWith(item.href));
            const Icon = item.icon;
            const label =
              (t.nav as Record<string, string>)[item.labelKey] ?? item.labelKey;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${
                  isActive
                    ? "bg-accent-light text-accent"
                    : "text-text-secondary bg-bg-main"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </Link>
            );
          })}
        </nav>

        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
