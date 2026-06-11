import { PageSkeleton } from "@/components/ui/PageSkeleton";

export default function InventoryLoading() {
  return <PageSkeleton cards variant="grid" rows={12} />;
}
