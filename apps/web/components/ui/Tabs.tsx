"use client";

import { cn } from "@/lib/utils";

export interface TabItem<K extends string = string> {
  key: K;
  label: string;
  /** Optional badge shown next to the label (e.g. counts, "جديد"). */
  badge?: string | number;
}

interface TabsProps<K extends string> {
  items: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}

export function Tabs<K extends string>({
  items,
  active,
  onChange,
  className,
}: TabsProps<K>) {
  return (
    <div
      role="tablist"
      className={cn(
        "flex items-center gap-1 overflow-x-auto bg-bg-card border border-border rounded-xl p-1",
        className,
      )}
    >
      {items.map((it) => {
        const isActive = it.key === active;
        return (
          <button
            key={it.key}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(it.key)}
            className={cn(
              "shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors",
              isActive
                ? "bg-white text-text-primary shadow-sm"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            <span>{it.label}</span>
            {it.badge != null && (
              <span
                className={cn(
                  "text-[10px] font-bold rounded-full px-1.5 py-0.5",
                  isActive
                    ? "bg-accent-light text-accent"
                    : "bg-bg-main text-text-secondary",
                )}
              >
                {it.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
