import { PageSkeleton } from "./PageSkeleton";

/**
 * Kept as an alias for any old callsites — renders the page skeleton
 * instead of a spinner so loading states stay consistent.
 */
export function LoadingSpinner({ className: _className }: { className?: string } = {}) {
  return <PageSkeleton />;
}
