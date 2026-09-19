"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Check, Package, ListChecks, Info } from "@/lib/icons";
import { useNotifications, type NotificationKind } from "@/hooks/useNotifications";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  low_stock: Package,
  task_assigned: ListChecks,
  task_started: ListChecks,
  task_done: Check,
  task_updated: ListChecks,
  leave_submitted: Info,
  leave_decided: Info,
  info: Info,
};

const KIND_TONE: Record<NotificationKind, string> = {
  low_stock: "bg-orange-100 text-orange-700",
  task_assigned: "bg-accent-light text-accent",
  task_started: "bg-orange-50 text-orange-700",
  task_done: "bg-success-light text-success",
  task_updated: "bg-accent-light text-accent",
  leave_submitted: "bg-blue-50 text-blue-700",
  leave_decided: "bg-blue-50 text-blue-700",
  info: "bg-gray-100 text-text-secondary",
};

interface Props {
  /** Compact button used in tight spaces (e.g. inside the sidebar brand row). */
  variant?: "default" | "compact";
}

function formatRelative(date: Date): string {
  const diffSec = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "الآن";
  if (diffSec < 3600) return `منذ ${Math.floor(diffSec / 60)} دقيقة`;
  if (diffSec < 86400) return `منذ ${Math.floor(diffSec / 3600)} ساعة`;
  if (diffSec < 86400 * 7) return `منذ ${Math.floor(diffSec / 86400)} يوم`;
  return date.toLocaleDateString("ar-EG");
}

export function NotificationBell({ variant = "default" }: Props) {
  const { items, unread, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="الإشعارات"
        className={cn(
          "relative inline-flex items-center justify-center rounded-lg transition-colors",
          variant === "compact"
            ? "w-8 h-8 text-text-secondary hover:bg-bg-main hover:text-accent"
            : "w-10 h-10 text-text-secondary hover:bg-bg-main hover:text-accent",
          open && "text-accent bg-accent-light",
        )}
      >
        <Bell className={variant === "compact" ? "w-4 h-4" : "w-5 h-5"} />
        {unread > 0 && (
          <span
            className="absolute -top-1 -end-1 min-w-[18px] h-[18px] rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center px-1"
            aria-label={`${unread} إشعار جديد`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute end-0 top-full mt-2 w-[320px] sm:w-[360px] bg-white rounded-xl border border-border shadow-lg z-50 overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-text-primary">الإشعارات</h3>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-accent hover:underline"
              >
                تأشير الكل كمقروء
              </button>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Bell className="w-8 h-8 text-text-secondary mx-auto mb-2" />
                <p className="text-sm text-text-secondary">لا توجد إشعارات</p>
              </div>
            ) : (
              items.map((n) => {
                const Icon = KIND_ICON[n.kind] ?? Info;
                const tone = KIND_TONE[n.kind] ?? KIND_TONE.info;
                const Wrapper: React.ElementType = n.link ? Link : "div";
                const wrapperProps: Record<string, unknown> = n.link
                  ? { href: n.link }
                  : {};
                return (
                  <Wrapper
                    key={n.id}
                    {...wrapperProps}
                    onClick={() => {
                      if (!n.isRead) markRead(n.id);
                      if (n.link) setOpen(false);
                    }}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0 transition-colors",
                      n.isRead ? "bg-white" : "bg-accent-light/30",
                      n.link ? "cursor-pointer hover:bg-bg-main" : "",
                    )}
                  >
                    <div
                      className={cn(
                        "shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
                        tone,
                      )}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {n.title}
                        </p>
                        {!n.isRead && (
                          <span
                            className="w-2 h-2 rounded-full bg-accent shrink-0"
                            aria-hidden
                          />
                        )}
                      </div>
                      {n.body && (
                        <p className="text-xs text-text-secondary line-clamp-2">
                          {n.body}
                        </p>
                      )}
                      <p className="text-[10px] text-text-secondary mt-1">
                        {formatRelative(n.createdAt)}
                      </p>
                    </div>
                  </Wrapper>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
