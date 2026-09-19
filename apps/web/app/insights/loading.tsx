import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function InsightsLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards chart rows={5} />
    </SkeletonShell>
  );
}
