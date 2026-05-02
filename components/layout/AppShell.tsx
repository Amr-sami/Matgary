"use client";

import { ReactNode, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { MobileBottomNav } from "./MobileBottomNav";

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
    <div className="min-h-screen bg-bg-main overflow-x-hidden">
      {/* Desktop Sidebar */}
      <div
        suppressHydrationWarning
        className={`hidden lg:block fixed start-0 top-0 h-screen bg-bg-card border-e border-border z-40 no-print ${transitionClass} ${
          collapsed ? "w-16" : "w-52"
        }`}
      >
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </div>

      {/* Main Content Area */}
      <div
        suppressHydrationWarning
        className={`min-h-screen flex flex-col ${transitionClass} ${
          collapsed ? "lg:ms-16" : "lg:ms-52"
        }`}
      >
        <main className="flex-1 p-4 md:p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">{children}</main>
      </div>

      {/* Mobile Bottom Nav */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-50 no-print">
        <MobileBottomNav />
      </div>
    </div>
  );
}
