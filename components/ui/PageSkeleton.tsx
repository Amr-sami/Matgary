import { Skeleton } from "./Skeleton";

interface PageSkeletonProps {
  /** Show 4 stat cards under the header. */
  cards?: boolean;
  /** Render a chart placeholder block above the list. */
  chart?: boolean;
  /** Number of list rows. */
  rows?: number;
  /** Use a grid of card placeholders instead of list rows (e.g. inventory). */
  variant?: "list" | "grid";
}

/**
 * Page-level loading skeleton. Replaces the spinner so the user sees the
 * shape of the upcoming UI instead of a frozen circle. Matches the common
 * layout shared by the data pages: header → optional stat cards → list/grid.
 */
export function PageSkeleton({
  cards = true,
  chart = false,
  rows = 6,
  variant = "list",
}: PageSkeletonProps) {
  return (
    // Outer padding intentionally omitted: callers wrap us in either
    // `AppShell` (in-page Suspense fallbacks) or `SkeletonShell` (route
    // loading.tsx), both of which provide `p-4 md:p-6` themselves.
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 sm:gap-4">
        <div className="space-y-2 flex-1 min-w-0">
          <Skeleton className="h-7 w-32 sm:w-40 max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-10 w-20 sm:w-28 rounded-lg shrink-0" />
      </div>

      {cards && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="p-4 rounded-xl border border-border bg-bg-card space-y-3"
            >
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      )}

      {chart && (
        <div className="rounded-xl border border-border bg-bg-card p-4 space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {variant === "list" ? (
        <div className="rounded-xl border border-border bg-bg-card divide-y divide-border overflow-hidden">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2 min-w-0">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-6 w-16 rounded-md shrink-0" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-bg-card p-3 space-y-3"
            >
              <Skeleton className="h-32 w-full rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
