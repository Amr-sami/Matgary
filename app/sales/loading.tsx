import { PageSkeleton } from "@/components/ui/PageSkeleton";

export default function SalesLoading() {
  return <PageSkeleton cards chart rows={10} />;
}
