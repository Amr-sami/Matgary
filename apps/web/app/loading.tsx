// Root-segment streaming fallback. Shown while a Server Component anywhere
// under `/` is still resolving its async work (data fetches, db calls). On
// purely-client pages this is invisible because the page tree hydrates
// without server-suspended work, but every async server boundary gets a
// painted fallback "for free" instead of a blank page.

import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function RootLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards rows={6} />
    </SkeletonShell>
  );
}
