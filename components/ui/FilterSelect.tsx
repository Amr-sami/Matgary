"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  /** When true, the trigger fills its container instead of sitting as an
   *  inline-block chip. Used when the dropdown replaces a native `<select>`
   *  inside a form column rather than a filter row. */
  fullWidth?: boolean;
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
  fullWidth = false,
  className,
  ariaLabel,
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  // Portal mount target — only set in the browser so SSR stays inert. Refs
  // resolved on mount via useLayoutEffect to avoid the first-paint flash that
  // would happen if the menu rendered at (0,0) before measuring.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [menuRect, setMenuRect] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: "below" | "above";
  } | null>(null);

  useLayoutEffect(() => {
    if (typeof document !== "undefined") setPortalNode(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Click-outside / Escape close. Includes the portalled menu so clicks
    // inside an <li> don't trip the outside-click handler.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
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

  // Position the portalled menu relative to the trigger. Recompute on open,
  // on scroll, and on resize so the menu tracks its anchor.
  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    const measure = () => {
      const trigger = wrapRef.current?.querySelector("button");
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const margin = 8;
      const desiredMax = 288; // matches Tailwind max-h-72
      const spaceBelow = viewportH - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const placement: "below" | "above" =
        spaceBelow >= Math.min(desiredMax, 160) || spaceBelow >= spaceAbove
          ? "below"
          : "above";
      const maxHeight = Math.max(
        120,
        Math.min(desiredMax, placement === "below" ? spaceBelow : spaceAbove),
      );
      const top =
        placement === "below" ? r.bottom + 6 : Math.max(margin, r.top - 6);
      setMenuRect({
        top,
        left: r.left,
        width: r.width,
        maxHeight,
        placement,
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
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
    <div
      ref={wrapRef}
      className={cn(
        "relative",
        fullWidth ? "block w-full" : "inline-block",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? allLabel ?? activeLabel}
        className={cn(
          "items-center justify-between gap-2 rounded-lg border border-border bg-white transition-colors hover:border-text-secondary/40",
          fullWidth
            ? "flex w-full px-4 py-2.5 text-text-primary focus:outline-none focus:border-accent"
            : "inline-flex min-w-[140px] px-3 py-2 text-sm",
          // Neutral colour only — selection state shows via the active row's
          // accent + check in the menu, not via the trigger's border. Matches
          // the rest of the filter chips on /customers, /sales etc.
          hasSelection ? "text-text-primary" : "text-text-secondary",
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

      {open && portalNode && menuRect && createPortal(
        <ul
          ref={menuRef}
          role="listbox"
          style={{
            position: "fixed",
            top:
              menuRect.placement === "above"
                ? undefined
                : menuRect.top,
            bottom:
              menuRect.placement === "above"
                ? window.innerHeight - menuRect.top
                : undefined,
            left: menuRect.left,
            width: fullWidth ? menuRect.width : undefined,
            minWidth: fullWidth ? undefined : menuRect.width,
            maxHeight: menuRect.maxHeight,
          }}
          className={cn(
            "z-[60] overflow-y-auto rounded-xl border border-border bg-white shadow-lg py-1",
            !fullWidth && "max-w-[320px] w-max",
          )}
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
        </ul>,
        portalNode,
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
  fullWidth?: boolean;
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
  fullWidth,
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
      fullWidth={fullWidth}
      className={className}
      ariaLabel={ariaLabel}
    />
  );
}
