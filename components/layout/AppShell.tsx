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

export function AppShell({ children, title }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "1") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-bg-main overflow-x-hidden">
      {/* Desktop Sidebar */}
      <div
        className={`hidden lg:block fixed start-0 top-0 h-screen bg-bg-card border-e border-border z-40 no-print transition-[width] duration-300 ease-in-out ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </div>

      {/* Main Content Area */}
      <div
        className={`min-h-screen flex flex-col transition-[margin] duration-300 ease-in-out ${
          collapsed ? "lg:ms-16" : "lg:ms-60"
        }`}
      >
        <main className="flex-1 p-4 md:p-6 pb-24 lg:pb-6">{children}</main>
      </div>

      {/* Mobile Bottom Nav */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-50 no-print">
        <MobileBottomNav />
      </div>
    </div>
  );
}
