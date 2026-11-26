import { View } from "react-native";
import type { collections } from "@matgary/api-client";

import { Badge } from "@/components/ui/Badge";
import { t } from "@/i18n";

type Status = collections.CollectionStatus | collections.SaleCollectionStatus;

const VARIANT: Record<Status, "lowstock" | "success" | "outofstock" | "neutral"> = {
  pending: "lowstock",
  confirmed: "success",
  auto_confirmed: "success",
  rejected: "outofstock",
  void: "neutral",
};

/**
 * The one status pill for a transfer, anywhere it shows (POS result card,
 * history, sale detail, dashboard, inbox, settle log) — doc 15 spec 08 §4.9.
 * Label `app.collections.vocab.status.<status>`; the wrapper carries
 * `collection-badge-<status>` (collapsable={false}: Android would flatten a
 * layout-only View and its testID with it).
 */
export function CollectionBadge({ status, testID }: { status: Status | null | undefined; testID?: string }) {
  if (!status) return null;
  return (
    <View testID={testID ?? `collection-badge-${status}`} collapsable={false}>
      <Badge label={t(`app.collections.vocab.status.${status}`)} variant={VARIANT[status] ?? "neutral"} />
    </View>
  );
}
