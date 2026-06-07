"use client";

import { useState } from "react";
import { Trash2, Tag, Wrench, Download, X, Percent, Truck, MapPin, Package } from "@/lib/icons";
import type { Category, Gender, Product } from "@/lib/types";
import { useCategories } from "@/hooks/useCategories";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export type BulkAction =
  | { type: "delete" }
  | { type: "addTag"; tag: string }
  | { type: "priceMultiplier"; multiplier: number }
  | { type: "category"; value: Category }
  | { type: "gender"; value: Gender }
  | { type: "supplier"; value: string }
  | { type: "location"; value: string }
  | { type: "exportCsv" };

interface BulkActionsBarProps {
  selected: Product[];
  onClear: () => void;
  onAction: (action: BulkAction) => void;
}

// Built-in gender options as a fallback when no per-category gender attribute
// is defined yet. Keys are the stored attribute values (Arabic in v1 DBs).
const FALLBACK_GENDERS: { value: string; labelKey: "male" | "female" }[] = [
  { value: "رجالي", labelKey: "male" },
  { value: "حريمي", labelKey: "female" },
];

export function BulkActionsBar({ selected, onClear, onAction }: BulkActionsBarProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.bulkActions;
  const { data: categories } = useCategories();
  const [openMenu, setOpenMenu] = useState<null | "tag" | "price" | "category" | "gender" | "supplier" | "location">(null);
  const [tagInput, setTagInput] = useState("");
  const [percentInput, setPercentInput] = useState("");
  const [supplierInput, setSupplierInput] = useState("");
  const [locationInput, setLocationInput] = useState("");

  if (selected.length === 0) return null;

  const closeMenus = () => setOpenMenu(null);
  const genderLabel = (key: "male" | "female") => (key === "male" ? "رجالي" : "حريمي");

  return (
    <div className="sticky top-2 z-20 bg-accent text-white rounded-xl shadow-lg p-3 flex flex-wrap items-center gap-2">
      <span className="font-medium text-sm">
        {t.selectedCount.replace("{n}", String(selected.length))}
      </span>
      <div className="flex-1" />

      {/* Add tag */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "tag" ? null : "tag")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Tag className="w-4 h-4" />
          {t.addTag}
        </button>
        {openMenu === "tag" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[220px]">
            <input
              autoFocus
              dir="auto"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder={t.tagInputPlaceholder}
              className="flex-1 px-2 py-1.5 border border-border rounded text-sm"
            />
            <button
              onClick={() => {
                if (tagInput.trim()) {
                  onAction({ type: "addTag", tag: tagInput.trim() });
                  setTagInput("");
                  closeMenus();
                }
              }}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm"
            >
              {t.apply}
            </button>
          </div>
        )}
      </div>

      {/* Bulk price bump */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "price" ? null : "price")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Percent className="w-4 h-4" />
          {t.priceAdjust}
        </button>
        {openMenu === "price" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[260px]">
            <input
              autoFocus
              type="number"
              dir="ltr"
              value={percentInput}
              onChange={(e) => setPercentInput(e.target.value)}
              placeholder={t.pricePlaceholder}
              className="flex-1 px-2 py-1.5 border border-border rounded text-sm"
            />
            <button
              onClick={() => {
                const pct = Number(percentInput);
                if (!Number.isNaN(pct) && pct !== 0) {
                  onAction({ type: "priceMultiplier", multiplier: 1 + pct / 100 });
                  setPercentInput("");
                  closeMenus();
                }
              }}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm whitespace-nowrap"
            >
              {t.applyPercent}
            </button>
          </div>
        )}
      </div>

      {/* Change category — sourced from per-tenant category list */}
      {categories.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setOpenMenu(openMenu === "category" ? null : "category")}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
          >
            <Package className="w-4 h-4" />
            {t.category}
          </button>
          {openMenu === "category" && (
            <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex flex-col min-w-[160px]">
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onAction({ type: "category", value: c.id });
                    closeMenus();
                  }}
                  className="text-start px-3 py-1.5 hover:bg-gray-100 rounded text-sm"
                  dir="auto"
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Change gender — fixed list backing the legacy attribute */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "gender" ? null : "gender")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Wrench className="w-4 h-4" />
          {t.gender}
        </button>
        {openMenu === "gender" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex flex-col min-w-[140px]">
            {FALLBACK_GENDERS.map((g) => (
              <button
                key={g.value}
                onClick={() => {
                  onAction({ type: "gender", value: g.value });
                  closeMenus();
                }}
                className="text-start px-3 py-1.5 hover:bg-gray-100 rounded text-sm"
                dir="auto"
              >
                {genderLabel(g.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Set supplier */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "supplier" ? null : "supplier")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Truck className="w-4 h-4" />
          {t.supplier}
        </button>
        {openMenu === "supplier" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[240px]">
            <input
              autoFocus
              dir="auto"
              value={supplierInput}
              onChange={(e) => setSupplierInput(e.target.value)}
              placeholder={t.supplierPlaceholder}
              className="flex-1 px-2 py-1.5 border border-border rounded text-sm"
            />
            <button
              onClick={() => {
                onAction({ type: "supplier", value: supplierInput.trim() });
                setSupplierInput("");
                closeMenus();
              }}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm"
            >
              {t.apply}
            </button>
          </div>
        )}
      </div>

      {/* Set location */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "location" ? null : "location")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <MapPin className="w-4 h-4" />
          {t.location}
        </button>
        {openMenu === "location" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[240px]">
            <input
              autoFocus
              dir="auto"
              value={locationInput}
              onChange={(e) => setLocationInput(e.target.value)}
              placeholder={t.locationPlaceholder}
              className="flex-1 px-2 py-1.5 border border-border rounded text-sm"
            />
            <button
              onClick={() => {
                onAction({ type: "location", value: locationInput.trim() });
                setLocationInput("");
                closeMenus();
              }}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm"
            >
              {t.apply}
            </button>
          </div>
        )}
      </div>

      {/* Export */}
      <button
        onClick={() => onAction({ type: "exportCsv" })}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
      >
        <Download className="w-4 h-4" />
        {t.export}
      </button>

      {/* Delete */}
      <button
        onClick={() => onAction({ type: "delete" })}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-danger hover:bg-danger/90 text-sm"
      >
        <Trash2 className="w-4 h-4" />
        {t.delete}
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        className="p-1.5 rounded-lg hover:bg-white/10"
        title={t.clearTitle}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
