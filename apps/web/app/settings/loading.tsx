import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { SkeletonShell } from "@/components/ui/SkeletonShell";

export default function SettingsLoading() {
  return (
    <SkeletonShell>
      <PageSkeleton cards={false} rows={8} />
    </SkeletonShell>
  );
}
