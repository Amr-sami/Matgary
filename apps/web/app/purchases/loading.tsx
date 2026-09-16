import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function PurchasesLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards rows={8} />
    </SkeletonShell>
  );
}
