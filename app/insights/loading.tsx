import { PageSkeleton } from "@/components/ui/PageSkeleton";

export default function InsightsLoading() {
  return <PageSkeleton cards chart rows={5} />;
}
