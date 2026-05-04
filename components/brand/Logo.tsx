import { cn } from "@/lib/utils";

interface LogoProps {
  /** Tailwind text size for the Arabic wordmark — controls overall logo size. */
  size?: "sm" | "md" | "lg";
  /** Override or extend the color/text classes (e.g. `text-white` on a colored bg). */
  className?: string;
}

const ARABIC_SIZE: Record<NonNullable<LogoProps["size"]>, string> = {
  sm: "text-2xl",
  md: "text-4xl",
  lg: "text-5xl",
};

const ENGLISH_SIZE: Record<NonNullable<LogoProps["size"]>, string> = {
  sm: "text-[9px] tracking-[0.22em]",
  md: "text-xs tracking-[0.25em]",
  lg: "text-sm tracking-[0.28em]",
};

/**
 * Brand wordmark, rendered as live text so it stays crisp at every size and
 * inherits whatever text color is set on the parent (or via the className
 * prop) — defaults to the brand accent.
 */
export function Logo({ size = "md", className }: LogoProps) {
  return (
    <div
      className={cn(
        "inline-flex flex-col items-center justify-center gap-1 select-none text-accent",
        className,
      )}
      aria-label="متجري"
    >
      <span dir="rtl" className={cn("font-extrabold leading-none", ARABIC_SIZE[size])}>
        متجري
      </span>
      <span
        dir="ltr"
        className={cn("font-semibold uppercase leading-none", ENGLISH_SIZE[size])}
      >
        MATJARI
      </span>
    </div>
  );
}
