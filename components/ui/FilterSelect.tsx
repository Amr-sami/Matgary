"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";

/** An option entry — either a plain string (value === label) or an explicit
 *  `{value, label}` pair so callers can pass IDs whose user-facing label
 *  differs from the underlying value (e.g. supplier ID + supplier name). */
export type FilterOption = string | { value: string; label: string };

interface FilterSelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  options: FilterOption[];
  /** Label shown when `value` is null (also drives the "clear" row).
   *  Required when `nullable` is true. */
  allLabel?: string;
  /** When true (default), the menu shows a top "clear" row and `onChange`
   *  may be invoked with `null`. When false, the menu has no clear row and
   *  the trigger always shows the selected option's label. */
  nullable?: boolean;
  /** Optional text prepended to the displayed label, e.g. "Sort: ". */
  prefix?: string;
  /** Optional icon rendered before the label in the trigger. */
  leadingIcon?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

/**
 * Unified single-select dropdown for filters and sorts across the app.
 *
 * - Trigger: rounded-lg, 1px border, white bg, chevron toggles 180° on open
 * - Menu: anchored `top-full mt-1.5`; rounded-xl card with soft shadow;
 *   `min-w-full w-max max-w-[280px]` so it never collapses below the trigger
 *   width nor stretches absurdly wide
 * - Scrolls internally (`max-h-72`) for long lists; active row highlighted in
 *   accent with a Check on the trailing edge
 * - Closes on outside click and Escape
 * - Identical rendering on desktop and mobile (no native picker, no full-
 *   screen sheet) so behaviour is the same everywhere
 */
export function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  nullable = true,
  prefix,
  leadingIcon,
  className,
  ariaLabel,
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Normalize string options to {value, label} so we can render uniformly.
  const normalized = useMemo(
    () =>
      options.map((o) =>
        typeof o === "string" ? { value: o, label: o } : o,
      ),
    [options],
  );

  const activeLabel = useMemo(() => {
    if (value == null) return allLabel ?? "";
    return normalized.find((o) => o.value === value)?.label ?? value;
  }, [normalized, value, allLabel]);

  const triggerLabel = `${prefix ?? ""}${activeLabel}`;
  const hasSelection = value !== null;

  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? allLabel ?? activeLabel}
        className={cn(
          "inline-flex items-center justify-between gap-2 min-w-[140px] px-3 py-2 rounded-lg border bg-white text-sm transition-colors",
          hasSelection
            ? "border-accent/40 text-text-primary"
            : "border-border text-text-secondary hover:border-accent/50",
          open && "border-accent/60 ring-2 ring-accent/15",
        )}
        dir="auto"
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {leadingIcon && (
            <span className="shrink-0 text-text-secondary inline-flex items-center">
              {leadingIcon}
            </span>
          )}
          <span className="truncate">{triggerLabel}</span>
        </span>
        <ChevronDown
          className={cn(
            "w-4 h-4 shrink-0 text-text-secondary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute start-0 top-full mt-1.5 z-30 min-w-full w-max max-w-[280px] max-h-72 overflow-y-auto rounded-xl border border-border bg-white shadow-lg py-1"
        >
          {nullable && allLabel && (
            <>
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === null}
                  onClick={() => choose(null)}
                  className={cn(
                    "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-start hover:bg-bg-main transition-colors",
                    value === null && "font-semibold text-accent",
                  )}
                >
                  <span className="truncate">{allLabel}</span>
                  {value === null && (
                    <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                  )}
                </button>
              </li>
              {normalized.length > 0 && (
                <li aria-hidden className="h-px bg-border my-1 mx-2" />
              )}
            </>
          )}
          {normalized.map((opt) => {
            const isActive = opt.value === value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => choose(opt.value)}
                  className={cn(
                    "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-start hover:bg-bg-main transition-colors",
                    isActive && "font-semibold text-accent",
                  )}
                  dir="auto"
                >
                  <span className="truncate">{opt.label}</span>
                  {isActive && (
                    <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface SortSelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  prefix?: string;
  leadingIcon?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

/** Convenience wrapper around `FilterSelect` for sort menus: non-nullable,
 *  typed via a string union so the consumer doesn't have to cast inside
 *  `onChange`. Renders with the same chrome as `FilterSelect`. */
export function SortSelect<T extends string>({
  value,
  onChange,
  options,
  prefix,
  leadingIcon,
  className,
  ariaLabel,
}: SortSelectProps<T>) {
  return (
    <FilterSelect
      value={value}
      onChange={(v) => {
        if (v != null) onChange(v as T);
      }}
      options={options as { value: string; label: string }[]}
      nullable={false}
      prefix={prefix}
      leadingIcon={leadingIcon}
      className={className}
      ariaLabel={ariaLabel}
    />
  );
}
