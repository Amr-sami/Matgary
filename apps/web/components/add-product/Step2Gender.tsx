"use client";

import { User, UserRound } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Gender } from "@/lib/types";

interface Step2GenderProps {
  selected: Gender | null;
  onSelect: (gender: Gender) => void;
}

export function Step2Gender({ selected, onSelect }: Step2GenderProps) {
  const genders = [
    { value: "male" as Gender, label: "رجالي", icon: User },
    { value: "female" as Gender, label: "حريمي", icon: UserRound },
  ];

  return (
    <div>
      <h3 className="text-center font-semibold mb-6">اختر الجنس</h3>
      <div className="grid grid-cols-2 gap-4 max-w-md mx-auto">
        {genders.map((gender) => {
          const Icon = gender.icon;
          const isSelected = selected === gender.value;

          return (
            <button
              key={gender.value}
              onClick={() => onSelect(gender.value)}
              className={cn(
                "flex flex-col items-center justify-center p-8 rounded-xl border-2 transition-all",
                isSelected
                  ? "border-accent bg-accent-light text-accent"
                  : "border-border bg-white hover:border-accent/50"
              )}
            >
              <Icon className={cn("w-16 h-16 mb-4", isSelected && "text-accent")} />
              <span className="text-xl font-semibold">{gender.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}