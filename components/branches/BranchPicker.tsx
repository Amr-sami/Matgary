"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Store, Check, ChevronDown, Plus } from "@/lib/icons";
import { useBranches } from "@/hooks/useBranches";
import { cn } from "@/lib/utils";

interface Props {
  /** Compact pill for tight headers; default for the standard topbar slot. */
  variant?: "default" | "compact";
}

export function BranchPicker({ variant = "default" }: Props) {
  const { data: session } = useSession();
  const { branches, current, loading, switchTo } = useBranches();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
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

  // Hide entirely until we know the picture. Critically, also hide when the
  // tenant has only one branch — the picker is dead UI for single-store
  // owners and surfaces the multi-branch concept only when it's relevant.
  if (loading || branches.length <= 1) return null;

  const isOwner = session?.user?.role === "owner";

  const onPick = async (id: string) => {
    if (id === current?.id) {
      setOpen(false);
      return;
    }
    setBusyId(id);
    try {
      await switchTo(id);
      // switchTo triggers a full reload — we won't reach the next line on
      // success, but on failure we want to drop the spinner and surface the
      // current state.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border border-border bg-white text-text-primary transition-colors hover:border-accent",
          variant === "compact"
            ? "px-2.5 py-1.5 text-xs"
            : "px-3 py-2 text-sm",
          open && "border-accent",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Store className={variant === "compact" ? "w-3.5 h-3.5" : "w-4 h-4"} />
        <span className="font-medium truncate max-w-[140px]">
          {current?.name ?? "اختر فرعاً"}
        </span>
        <ChevronDown
          className={cn(
            variant === "compact" ? "w-3 h-3" : "w-3.5 h-3.5",
            "text-text-secondary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute end-0 top-full mt-2 w-[260px] bg-white rounded-xl border border-border shadow-lg z-50 overflow-hidden"
        >
          <div className="px-4 py-2 border-b border-border">
            <p className="text-[10px] uppercase tracking-wider text-text-secondary">
              الفرع الحالي
            </p>
          </div>
          <ul className="max-h-[280px] overflow-y-auto">
            {branches
              .filter((b) => b.isActive)
              .map((b) => {
                const isCurrent = b.id === current?.id;
                const busy = busyId === b.id;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      onClick={() => onPick(b.id)}
                      disabled={busy}
                      className={cn(
                        "w-full flex items-start gap-3 px-4 py-2.5 text-right transition-colors",
                        isCurrent
                          ? "bg-accent-light/40"
                          : "hover:bg-bg-main",
                      )}
                    >
                      <div className="shrink-0 mt-0.5">
                        {isCurrent ? (
                          <Check className="w-4 h-4 text-accent" />
                        ) : (
                          <span className="block w-4 h-4" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {b.name}
                          {b.isPrimary && (
                            <span className="ms-2 text-[10px] text-accent">
                              رئيسي
                            </span>
                          )}
                        </p>
                        {b.address && (
                          <p className="text-xs text-text-secondary truncate">
                            {b.address}
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
          </ul>
          {isOwner && (
            <Link
              href="/settings/branches"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-4 py-2.5 border-t border-border text-sm text-accent hover:bg-bg-main transition-colors"
            >
              <Plus className="w-4 h-4" />
              إدارة الفروع
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
