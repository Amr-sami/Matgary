"use client";

import { useState } from "react";
import { Trash2, Tag, Wrench, Download, X, Percent, Truck, MapPin, Package } from "@/lib/icons";
import type { Category, Gender, Product } from "@/lib/types";
import { CATEGORY_LABELS, GENDER_LABELS } from "@/lib/types";

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

export function BulkActionsBar({ selected, onClear, onAction }: BulkActionsBarProps) {
  const [openMenu, setOpenMenu] = useState<null | "tag" | "price" | "category" | "gender" | "supplier" | "location">(null);
  const [tagInput, setTagInput] = useState("");
  const [percentInput, setPercentInput] = useState("");
  const [supplierInput, setSupplierInput] = useState("");
  const [locationInput, setLocationInput] = useState("");

  if (selected.length === 0) return null;

  const closeMenus = () => setOpenMenu(null);

  return (
    <div className="sticky top-2 z-20 bg-accent text-white rounded-xl shadow-lg p-3 flex flex-wrap items-center gap-2">
      <span className="font-medium text-sm">
        تم تحديد {selected.length} منتج
      </span>
      <div className="flex-1" />

      {/* Add tag */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "tag" ? null : "tag")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Tag className="w-4 h-4" />
          إضافة تاج
        </button>
        {openMenu === "tag" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[220px]">
            <input
              autoFocus
              dir="rtl"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="اسم التاج"
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
              تطبيق
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
          تعديل السعر
        </button>
        {openMenu === "price" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[260px]">
            <input
              autoFocus
              type="number"
              dir="rtl"
              value={percentInput}
              onChange={(e) => setPercentInput(e.target.value)}
              placeholder="نسبة (مثال: 10 أو -5)"
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
              تطبيق %
            </button>
          </div>
        )}
      </div>

      {/* Change category */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "category" ? null : "category")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Package className="w-4 h-4" />
          الصنف
        </button>
        {openMenu === "category" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex flex-col min-w-[160px]">
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
              <button
                key={c}
                onClick={() => {
                  onAction({ type: "category", value: c });
                  closeMenus();
                }}
                className="text-start px-3 py-1.5 hover:bg-gray-100 rounded text-sm"
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Change gender */}
      <div className="relative">
        <button
          onClick={() => setOpenMenu(openMenu === "gender" ? null : "gender")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm"
        >
          <Wrench className="w-4 h-4" />
          النوع
        </button>
        {openMenu === "gender" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex flex-col min-w-[140px]">
            {(Object.keys(GENDER_LABELS) as Gender[]).map((g) => (
              <button
                key={g}
                onClick={() => {
                  onAction({ type: "gender", value: g });
                  closeMenus();
                }}
                className="text-start px-3 py-1.5 hover:bg-gray-100 rounded text-sm"
              >
                {GENDER_LABELS[g]}
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
          المورد
        </button>
        {openMenu === "supplier" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[240px]">
            <input
              autoFocus
              dir="rtl"
              value={supplierInput}
              onChange={(e) => setSupplierInput(e.target.value)}
              placeholder="اسم المورد"
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
              تطبيق
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
          المكان
        </button>
        {openMenu === "location" && (
          <div className="absolute end-0 top-full mt-1 bg-white text-text-primary rounded-lg shadow-lg p-2 flex gap-2 min-w-[240px]">
            <input
              autoFocus
              dir="rtl"
              value={locationInput}
              onChange={(e) => setLocationInput(e.target.value)}
              placeholder="مكان التخزين"
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
              تطبيق
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
        تصدير
      </button>

      {/* Delete */}
      <button
        onClick={() => onAction({ type: "delete" })}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-danger hover:bg-danger/90 text-sm"
      >
        <Trash2 className="w-4 h-4" />
        حذف
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        className="p-1.5 rounded-lg hover:bg-white/10"
        title="إلغاء التحديد"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
