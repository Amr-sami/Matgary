"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { DollarSign, LogOut, User } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/app/(auth)/actions";

interface Props {
  collapsed: boolean;
}

export function UserMenu({ collapsed }: Props) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const email = session?.user?.email ?? "";
  const initial = (session?.user?.name?.charAt(0) || email.charAt(0) || "?").toUpperCase();

  const signOut = () => {
    startTransition(async () => {
      try {
        window.localStorage.removeItem("shop:settings:v1");
      } catch {}
      await logoutAction();
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? email : undefined}
        className={cn(
          "w-full flex items-center gap-2 rounded-lg p-2 hover:bg-bg-main transition-colors",
          collapsed && "justify-center",
        )}
      >
        <div className="w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center font-bold text-sm shrink-0">
          {initial}
        </div>
        <span
          className={cn(
            "text-xs text-text-secondary truncate text-start flex-1",
            collapsed && "hidden",
          )}
        >
          {email}
        </span>
      </button>

      {open && (
        <div
          className={cn(
            "absolute bottom-full mb-2 bg-bg-card border border-border rounded-xl shadow-lg overflow-hidden z-50",
            collapsed ? "start-full ms-2 w-48" : "inset-x-0",
          )}
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs text-text-secondary">مسجّل الدخول كـ</p>
            <p className="text-sm font-medium text-text-primary truncate">{email}</p>
          </div>
          {session?.user?.role === "owner" && (
            <Link
              href="/billing"
              onClick={() => setOpen(false)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-main hover:text-text-primary transition-colors"
            >
              <DollarSign className="w-4 h-4" />
              الاشتراك
            </Link>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={isPending}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-50 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            {isPending ? "جارٍ الخروج…" : "تسجيل الخروج"}
          </button>
        </div>
      )}
    </div>
  );
}
