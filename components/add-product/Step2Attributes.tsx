"use client";

import { User, UserRound } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { CategoryAttribute } from "@/lib/types";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Step2AttributesProps {
  attributes: CategoryAttribute[];
  selected: Record<string, string>; // attributeId -> valueId
  onSelect: (attributeId: string, valueId: string) => void;
}

// Pick a tasteful icon for the gender attribute so the cornerstore preset
// looks identical to the pre-migration UI. Other attributes render plain
// text-only buttons.
function iconForGender(valueKey: string) {
  if (valueKey === "male") return User;
  if (valueKey === "female") return UserRound;
  return null;
}

export function Step2Attributes({
  attributes,
  selected,
  onSelect,
}: Step2AttributesProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.addProduct.step2;
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-lg font-bold text-text-primary">{t.heading}</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          {t.subhead}
        </p>
      </div>

      {attributes.map((attr) => (
        <div key={attr.id}>
          <h3 className="text-sm font-semibold text-text-primary mb-3" dir="auto">
            {attr.label}
            {attr.required && <span className="text-danger ms-1">*</span>}
          </h3>
          <div
            className={cn(
              "grid gap-2.5",
              attr.values.length === 2
                ? "grid-cols-2"
                : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
            )}
          >
            {attr.values.map((value) => {
              const isSelected = selected[attr.id] === value.id;
              const Icon = attr.key === "gender" ? iconForGender(value.key) : null;
              return (
                <button
                  key={value.id}
                  type="button"
                  onClick={() => onSelect(attr.id, value.id)}
                  className={cn(
                    "flex items-center justify-center gap-2 px-4 py-3 rounded-xl border bg-white transition-all",
                    "hover:border-accent hover:shadow-sm",
                    isSelected
                      ? "border-accent bg-accent-light/40 ring-2 ring-accent/30 text-accent"
                      : "border-border text-text-primary",
                  )}
                  aria-pressed={isSelected}
                >
                  {Icon && (
                    <Icon
                      className={cn(
                        "w-5 h-5",
                        isSelected ? "text-accent" : "text-text-secondary",
                      )}
                    />
                  )}
                  <span className="text-sm font-semibold" dir="auto">{value.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
