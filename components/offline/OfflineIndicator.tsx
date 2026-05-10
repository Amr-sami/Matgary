"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  CloudOff,
  CloudUpload,
  Loader2,
  AlertCircle,
} from "@/lib/icons";
import { useOffline } from "@/hooks/useOffline";
import { cn } from "@/lib/utils";

// Topbar status pill. Three visual states:
//   - online + queue empty + no failures → hidden (no clutter for the
//     normal happy case).
//   - offline                            → orange, "غير متصل · N بانتظار".
//   - online + queue has rows OR syncing → blue, "جارٍ المزامنة (N)".
//   - online + failed rows               → red, "تعذرت مزامنة N — اضغط للمراجعة".
//
// Click opens a dropdown with per-row status + a manual "أعد المحاولة الآن"
// button.

export function OfflineIndicator() {
  const { online, syncing, queueDepth, failedCount, sync } = useOffline();
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

  // Happy path — don't add visual noise.
  if (online && queueDepth === 0 && failedCount === 0 && !syncing) {
    return null;
  }

  let tone:
    | "offline"
    | "syncing"
    | "failed" = "syncing";
  if (failedCount > 0) tone = "failed";
  else if (!online) tone = "offline";

  const palette = {
    offline: "bg-orange-100 text-orange-700 border-orange-200",
    syncing: "bg-blue-50 text-blue-700 border-blue-200",
    failed: "bg-danger-light text-danger border-danger/30",
  }[tone];

  const Icon =
    tone === "failed"
      ? AlertCircle
      : tone === "offline"
        ? CloudOff
        : syncing
          ? Loader2
          : CloudUpload;

  const label =
    tone === "failed"
      ? `${failedCount} لم تُرسل`
      : tone === "offline"
        ? queueDepth > 0
          ? `غير متصل · ${queueDepth} بانتظار`
          : "غير متصل"
        : syncing
          ? `جارٍ المزامنة${queueDepth ? ` (${queueDepth})` : ""}`
          : queueDepth > 0
            ? `${queueDepth} بانتظار المزامنة`
            : "تمت المزامنة";

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors",
          palette,
        )}
      >
        <Icon
          className={cn(
            "w-3.5 h-3.5",
            syncing && tone === "syncing" && "animate-spin",
          )}
        />
        <span>{label}</span>
      </button>

      {open && (
        <div className="absolute end-0 top-full mt-2 w-[280px] bg-white rounded-xl border border-border shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-xs font-semibold text-text-primary">
              حالة المزامنة
            </p>
          </div>
          <div className="px-4 py-3 space-y-2 text-xs text-text-secondary">
            <div className="flex items-center justify-between">
              <span>الاتصال</span>
              <span
                className={
                  online
                    ? "text-success font-medium"
                    : "text-orange-600 font-medium"
                }
              >
                {online ? "متصل" : "غير متصل"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>بانتظار الإرسال</span>
              <span className="font-medium tabular-nums">{queueDepth}</span>
            </div>
            {failedCount > 0 && (
              <div className="flex items-center justify-between">
                <span>فشل الإرسال</span>
                <span className="text-danger font-medium tabular-nums">
                  {failedCount}
                </span>
              </div>
            )}
          </div>
          {online && (queueDepth > 0 || failedCount > 0) && (
            <button
              type="button"
              onClick={() => {
                void sync();
              }}
              disabled={syncing}
              className="w-full px-4 py-2.5 border-t border-border text-sm text-accent hover:bg-bg-main transition-colors disabled:opacity-60"
            >
              {syncing ? "جاري المحاولة…" : "أعد المحاولة الآن"}
            </button>
          )}
          {!online && (
            <p className="px-4 py-2.5 border-t border-border text-[11px] text-text-secondary leading-relaxed">
              المبيعات تُسجَّل محلياً وسيتم رفعها تلقائياً عند عودة الإنترنت.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
