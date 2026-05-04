"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useScrollReveal } from "@/hooks/useScrollReveal";

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  /**
   * Direction the element animates IN from.
   *  - "up"    (default) slides from below.
   *  - "start" slides from the page-start side (right in RTL, left in LTR).
   *  - "end"   slides from the page-end side  (left in RTL, right in LTR).
   */
  direction?: "up" | "start" | "end";
}

const HIDDEN: Record<NonNullable<RevealProps["direction"]>, string> = {
  up: "translate-y-6",
  start: "-translate-x-8 rtl:translate-x-8",
  end: "translate-x-8 rtl:-translate-x-8",
};

export function Reveal({
  children,
  delay = 0,
  className,
  direction = "up",
}: RevealProps) {
  const { ref, shown } = useScrollReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "transition-all duration-700 ease-out will-change-[opacity,transform]",
        shown
          ? "opacity-100 translate-y-0 translate-x-0"
          : `opacity-0 ${HIDDEN[direction]}`,
        className,
      )}
    >
      {children}
    </div>
  );
}
