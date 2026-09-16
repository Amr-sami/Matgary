"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Search, Truck, X } from "@/lib/icons";
import { useSuppliers } from "@/hooks/useSuppliers";
import { SupplierFormModal } from "./SupplierFormModal";
import type { SupplierDescriptor } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  value: string | null;
  onChange: (supplierId: string | null) => void;
  label?: string;
  /** Show "+ Add new supplier" affordance when the user has manage_suppliers. */
  canCreate?: boolean;
}

/**
 * Combobox-style picker. Typing filters the visible suppliers; selecting writes
 * the supplier id back. The free-text fallback (legacy `supplier` column) is
 * not exposed here — pick a row, or open the modal to create one.
 */
export function SupplierPicker({ value, onChange, label, canCreate = true }: Props) {
  const dict = useDictionary();
  const t = dict.app.suppliers.picker;
  const effectiveLabel = label ?? t.label;
  const { data: suppliers, refresh } = useSuppliers();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => (value ? suppliers.find((s) => s.id === value) ?? null : null),
    [suppliers, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) =>
      `${s.name} ${s.phone || ""}`.toLowerCase().includes(q),
    );
  }, [suppliers, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = (s: SupplierDescriptor) => {
    onChange(s.id);
    setOpen(false);
    setQuery("");
  };

  const clear = () => {
    onChange(null);
    setQuery("");
  };

  return (
    <div className="w-full" ref={wrapperRef}>
      {effectiveLabel && (
        <label className="block text-sm font-medium text-text-secondary mb-1.5">
          {effectiveLabel}
        </label>
      )}

      {/* Trigger / display */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-accent transition-colors"
          dir="auto"
        >
          <Truck className="w-4 h-4 text-text-secondary shrink-0" />
          <span className="flex-1 text-start truncate">
            {selected ? selected.name : <span className="text-text-secondary">{t.placeholder}</span>}
          </span>
          {selected && (
            <span
              role="button"
              tabIndex={0}
              aria-label={t.clearAria}
              onClick={(e) => {
                e.stopPropagation();
                clear();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  clear();
                }
              }}
              className="p-0.5 rounded-md text-text-secondary hover:bg-gray-100"
            >
              <X className="w-4 h-4" />
            </span>
          )}
          <ChevronDown
            className={`w-4 h-4 text-text-secondary shrink-0 transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {/* Dropdown */}
        {open && (
          <div className="absolute z-20 mt-1 w-full bg-white border border-border rounded-lg shadow-lg max-h-72 overflow-hidden flex flex-col">
            <div className="relative border-b border-border">
              <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 end-3 text-text-secondary" />
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.search}
                className="w-full ps-3 pe-9 py-2 text-sm bg-white focus:outline-none"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-3 text-sm text-text-secondary text-center">
                  {query ? t.noResults : t.empty}
                </p>
              ) : (
                filtered.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => choose(s)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-bg-main ${
                      value === s.id ? "bg-accent-light text-accent" : ""
                    }`}
                  >
                    <Truck className="w-4 h-4 shrink-0" />
                    <span className="flex-1 truncate text-sm" dir="auto">{s.name}</span>
                    {s.phone && (
                      <span className="text-xs text-text-secondary truncate" dir="ltr">{s.phone}</span>
                    )}
                  </button>
                ))
              )}
            </div>
            {canCreate && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setModalOpen(true);
                }}
                className="border-t border-border px-3 py-2.5 text-sm text-accent font-medium hover:bg-accent-light flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                {t.addNew}
              </button>
            )}
          </div>
        )}
      </div>

      {canCreate && (
        <SupplierFormModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSaved={async (id) => {
            await refresh();
            onChange(id);
          }}
          onError={() => {
            // Surfacing here would require lifting a toast up — caller can rely
            // on the modal's own errors. We swallow silently to keep this picker
            // contained.
          }}
        />
      )}
    </div>
  );
}
