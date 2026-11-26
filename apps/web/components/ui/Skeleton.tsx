import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

/**
 * Minimal shimmer block. Compose larger skeleton layouts (page, card, row)
 * out of these.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-border/70",
        className,
      )}
      aria-hidden
    />
  );
}
