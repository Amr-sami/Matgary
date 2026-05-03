"use client";

import { User, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryAttribute } from "@/lib/types";

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
  return (
    <div className="space-y-8">
      {attributes.map((attr) => (
        <div key={attr.id}>
          <h3 className="text-center font-semibold mb-6">{attr.label}</h3>
          <div
            className={cn(
              "grid gap-4 max-w-md mx-auto",
              attr.values.length === 2 ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3",
            )}
          >
            {attr.values.map((value) => {
              const isSelected = selected[attr.id] === value.id;
              const Icon = attr.key === "gender" ? iconForGender(value.key) : null;
              return (
                <button
                  key={value.id}
                  onClick={() => onSelect(attr.id, value.id)}
                  className={cn(
                    "flex flex-col items-center justify-center p-8 rounded-xl border-2 transition-all",
                    isSelected
                      ? "border-accent bg-accent-light text-accent"
                      : "border-border bg-white hover:border-accent/50",
                  )}
                >
                  {Icon && (
                    <Icon
                      className={cn("w-16 h-16 mb-4", isSelected && "text-accent")}
                    />
                  )}
                  <span className="text-xl font-semibold">{value.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
