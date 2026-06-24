import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function CustomersLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards rows={10} />
    </SkeletonShell>
  );
}
