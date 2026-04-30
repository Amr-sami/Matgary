"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Phone, User, X } from "lucide-react";

export interface CustomerSuggestion {
  name: string;
  phone: string;
  invoiceCount?: number;
  lifetimeValue?: number;
}

interface CustomerAutocompleteProps {
  field: "name" | "phone";
  value: string;
  onChange: (v: string) => void;
  onPick: (suggestion: CustomerSuggestion) => void;
  suggestions: CustomerSuggestion[];
  placeholder?: string;
  label: string;
}

export function CustomerAutocomplete({
  field,
  value,
  onChange,
  onPick,
  suggestions,
  placeholder,
  label,
}: CustomerAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    const list = suggestions.filter((s) => {
      if (field === "name" && !s.name) return false;
      if (field === "phone" && !s.phone) return false;
      if (!q) return true;
      const nameHay = (s.name || "").toLowerCase();
      const phoneHay = (s.phone || "").toLowerCase();
      // Match either field by either name or digits typed
      if (nameHay.includes(q)) return true;
      if (phoneHay.includes(q)) return true;
      if (digits && phoneHay.replace(/\D/g, "").includes(digits)) return true;
      return false;
    });
    return list.slice(0, 10);
  }, [suggestions, value, field]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHovered((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHovered((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      onPick(filtered[hovered]);
      setOpen(false);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-text-secondary mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          type={field === "phone" ? "tel" : "text"}
          inputMode={field === "phone" ? "tel" : undefined}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHovered(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          dir="rtl"
          autoComplete="off"
          className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className="absolute end-2 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded text-text-secondary"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && filtered.length > 0 && (
        <div className="absolute top-full start-0 end-0 mt-1 z-30 bg-white border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {filtered.map((s, i) => (
            <button
              key={`${s.phone}-${s.name}-${i}`}
              type="button"
              onClick={() => {
                onPick(s);
                setOpen(false);
              }}
              onMouseEnter={() => setHovered(i)}
              className={`w-full text-start px-3 py-2 text-sm border-b border-border last:border-0 ${
                i === hovered ? "bg-accent-light" : "hover:bg-gray-50"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {field === "phone" ? (
                    <Phone className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                  ) : (
                    <User className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                  )}
                  <span className="truncate">
                    {field === "name" ? s.name || "بدون اسم" : s.phone}
                  </span>
                </div>
                <span className="text-[11px] text-text-secondary shrink-0">
                  {field === "name" ? s.phone : s.name || "بدون اسم"}
                </span>
              </div>
              {(s.invoiceCount || s.lifetimeValue) && (
                <div className="flex gap-2 text-[10px] text-text-secondary mt-0.5">
                  {s.invoiceCount !== undefined && (
                    <span>{s.invoiceCount} فاتورة</span>
                  )}
                  {s.lifetimeValue !== undefined && s.lifetimeValue > 0 && (
                    <span>· {s.lifetimeValue.toLocaleString("ar-EG")} ج.م</span>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
