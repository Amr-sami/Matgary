import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function InventoryLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards variant="grid" rows={12} />
    </SkeletonShell>
  );
}
