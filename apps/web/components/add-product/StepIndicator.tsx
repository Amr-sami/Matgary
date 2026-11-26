"use client";

import { Check } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface StepIndicatorProps {
  currentStep: number;
  /** When step 2 is skipped (category has no attributes) we collapse it visually. */
  skipStep2?: boolean;
}

// Modern segmented progress bar. Each step gets a numbered pill (or check),
// label + helper line, and a connector that fills as you progress. Helper
// text drops on mobile so the row stays in one line.
export function StepIndicator({ currentStep, skipStep2 }: StepIndicatorProps) {
  const dict = useDictionary();
  const t = dict.app.inventory.addProduct.indicator;
  const steps = [
    { num: 1, ...t.steps.category },
    { num: 2, ...t.steps.attributes },
    { num: 3, ...t.steps.details },
  ];

  return (
    <ol
      className="flex items-stretch gap-2 sm:gap-3 w-full"
      aria-label={t.ariaLabel}
    >
      {steps.map((step) => {
        const isCompleted = step.num < currentStep;
        const isActive = step.num === currentStep;
        const isMuted = step.num > currentStep || (skipStep2 && step.num === 2);

        return (
          <li key={step.num} className="flex-1 flex items-start gap-2 min-w-0">
            <div
              className={cn(
                "flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold shrink-0 transition-colors",
                isCompleted && "bg-accent text-white",
                isActive && "bg-accent text-white ring-4 ring-accent-light",
                isMuted && "bg-bg-main text-text-secondary",
              )}
              aria-current={isActive ? "step" : undefined}
            >
              {isCompleted ? <Check className="w-4 h-4" /> : step.num}
            </div>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm font-semibold leading-tight truncate",
                  isActive ? "text-text-primary" : "text-text-secondary",
                )}
              >
                {step.label}
              </p>
              <p className="hidden sm:block text-[11px] text-text-secondary mt-0.5 truncate">
                {step.helper}
              </p>
              <div
                className={cn(
                  "mt-2 h-1 rounded-full transition-colors",
                  isCompleted || isActive ? "bg-accent" : "bg-bg-main",
                )}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
