import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function SalesLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards chart rows={10} />
    </SkeletonShell>
  );
}
