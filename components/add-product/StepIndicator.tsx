"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepIndicatorProps {
  currentStep: number;
}

const steps = [
  { num: 1, label: "الصنف" },
  { num: 2, label: "الخصائص" },
  { num: 3, label: "التفاصيل" },
];

export function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-2 md:gap-4">
      {steps.map((step, i) => {
        const isCompleted = step.num < currentStep;
        const isActive = step.num === currentStep;

        return (
          <div key={step.num} className="flex items-center">
            <div
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-full font-medium text-sm transition-colors",
                isCompleted && "bg-accent text-white",
                isActive && "bg-accent text-white",
                !isCompleted && !isActive && "bg-gray-100 text-text-secondary"
              )}
            >
              {isCompleted ? (
                <Check className="w-5 h-5" />
              ) : (
                step.num
              )}
            </div>
            <span
              className={cn(
                "mx-2 text-sm hidden md:block",
                isActive ? "text-accent font-medium" : "text-text-secondary"
              )}
            >
              {step.label}
            </span>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "w-8 md:w-16 h-0.5",
                  isCompleted || isActive ? "bg-accent" : "bg-gray-200"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}