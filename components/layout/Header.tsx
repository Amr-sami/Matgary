"use client";

import { Menu } from "@/lib/icons";
import { formatDate } from "@/lib/utils";
import { BranchPicker } from "@/components/branches/BranchPicker";
import { CashDrawerChip } from "@/components/cash-shifts/CashDrawerChip";
import { OfflineIndicator } from "@/components/offline/OfflineIndicator";
import { SwRegister } from "@/components/offline/SwRegister";

interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  const today = formatDate(new Date());

  return (
    <header className="sticky top-0 z-30 bg-bg-main/80 backdrop-blur-md border-b border-border">
      {/* Side-effect mount: registers the service worker once on first
          render of the app shell. Renders nothing. */}
      <SwRegister />
      <div className="flex items-center justify-between px-4 py-4 md:px-6">
        <div className="flex items-center gap-4">
          <button className="lg:hidden p-2 -me-2 hover:bg-gray-100 rounded-lg">
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>
        <div className="flex items-center gap-3">
          {/* CashDrawerChip self-hides for users without open_close_shift. */}
          <CashDrawerChip />
          {/* OfflineIndicator self-hides when everything is healthy. */}
          <OfflineIndicator />
          {/* BranchPicker self-hides when the tenant has only one branch, so
              single-store owners don't see any clutter. */}
          <BranchPicker />
          <span className="hidden md:block text-sm text-text-secondary">{today}</span>
        </div>
      </div>
    </header>
  );
}