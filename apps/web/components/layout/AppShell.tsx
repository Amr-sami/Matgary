"use client";

import { ReactNode, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { MobileBottomNav } from "./MobileBottomNav";
import { OnboardingReminder } from "./OnboardingReminder";
import { DemoBanner } from "./DemoBanner";
import { CatalogProvider } from "@/components/catalog-context";
import { SettingsProvider } from "@/components/settings-context";
import { ImpersonationBanner } from "@/components/broadcasts/ImpersonationBanner";

interface AppShellProps {
  children: ReactNode;
  title: string;
}

const STORAGE_KEY = "sidebar:collapsed";

const readInitialCollapsed = () => {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
};

export function AppShell({ children, title }: AppShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readInitialCollapsed);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const transitionClass = mounted ? "transition-[width,margin] duration-300 ease-in-out" : "";

  return (
    <SettingsProvider>
    <CatalogProvider>
    {/* Top safe-area inset lives HERE, once, on the shell root: with
        viewport-fit=cover the document starts behind the status bar / notch /
        Dynamic Island, and every top surface (ImpersonationBanner, DemoBanner,
        OnboardingReminder, page content) is an in-flow child of this div — so
        one padding clears them all with no double counting. 0px on desktop. */}
    <div className="min-h-screen bg-bg-main overflow-x-hidden pt-[env(safe-area-inset-top)]">
      {/* Spec 07 — ImpersonationBanner renders ABOVE everything else,
          including the sidebar, so an admin acting as the owner sees the
          red strip persistently on every screen. */}
      <ImpersonationBanner />
      <DemoBanner />
      <OnboardingReminder />
      {/* Desktop Sidebar */}
      <div
        suppressHydrationWarning
        className={`hidden lg:block fixed start-0 top-0 h-screen pt-[env(safe-area-inset-top)] bg-bg-card border-e border-border z-40 no-print ${transitionClass} ${
          collapsed ? "w-16" : "w-52"
        }`}
      >
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </div>

      {/* Main Content Area — min-height subtracts the top inset the root just
          added, otherwise 100vh + inset would make every page scrollable by
          the height of the notch even with no content. calc(100vh - 0px) on
          desktop, i.e. unchanged. */}
      <div
        suppressHydrationWarning
        className={`min-h-[calc(100vh-env(safe-area-inset-top))] flex flex-col ${transitionClass} ${
          collapsed ? "lg:ms-16" : "lg:ms-52"
        }`}
      >
        <main className="flex-1 p-4 md:p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      {/* pl/pr (not ps/pe — these insets are physical, not directional) keep
          the bar clear of the notch when a notched phone is held sideways. */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-50 no-print pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <MobileBottomNav />
      </div>
    </div>
    </CatalogProvider>
    </SettingsProvider>
  );
}
