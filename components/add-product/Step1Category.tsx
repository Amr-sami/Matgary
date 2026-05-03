"use client";

import * as Icons from "lucide-react";
import { Package } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryDescriptor } from "@/lib/types";

interface Step1CategoryProps {
  categories: CategoryDescriptor[];
  selectedId: string | null;
  onSelect: (categoryId: string) => void;
  loading?: boolean;
}

// Resolve a stored icon name (e.g. "Watch") to a lucide component, falling
// back to Package if the tenant chose a name we don't ship. The fallback
// keeps the wizard usable for tenants that pick custom icons we haven't
// curated yet.
function getIcon(name: string | null) {
  if (!name) return Package;
  const lib = Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>;
  return lib[name] ?? Package;
}

export function Step1Category({
  categories,
  selectedId,
  onSelect,
  loading,
}: Step1CategoryProps) {
  if (loading) {
    return (
      <div className="text-center py-12 text-text-secondary">جاري التحميل…</div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="text-center py-8 space-y-3">
        <h3 className="font-semibold text-text-primary">لا توجد أقسام بعد</h3>
        <p className="text-sm text-text-secondary">
          أضف أول قسم من <span className="text-accent">الإعدادات</span> ثم ابدأ بإضافة المنتجات.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-center font-semibold mb-6">اختر الصنف</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {categories.map((cat) => {
          const Icon = getIcon(cat.icon);
          const isSelected = selectedId === cat.id;

          return (
            <button
              key={cat.id}
              onClick={() => onSelect(cat.id)}
              className={cn(
                "flex flex-col items-center justify-center p-8 rounded-xl border-2 transition-all",
                isSelected
                  ? "border-accent bg-accent-light text-accent"
                  : "border-border bg-white hover:border-accent/50",
              )}
            >
              <Icon className={cn("w-16 h-16 mb-4", isSelected && "text-accent")} />
              <span className="text-xl font-semibold">{cat.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
