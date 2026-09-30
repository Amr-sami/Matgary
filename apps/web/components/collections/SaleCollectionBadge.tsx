"use client";

import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { useCollectionsAccess } from "@/hooks/useCollections";
import { CollectionPill } from "./CollectionPill";
import { salePills, type SaleLike } from "./rules";

/**
 * The collection pill next to a sale's method pill (doc 15 spec 12 §4.5):
 * only `pending` / `rejected` (confirmed is the quiet, normal state). A link
 * to `/collections?invoice=<invoiceId>` for `view_collections`, else plain
 * text. Renders nothing for a non-digital sale.
 */
export function SaleCollectionBadge({ sale }: { sale: SaleLike & { invoiceId?: string | null } }) {
  const { collection } = salePills(sale);
  if (!collection) return null;
  return <Inner status={collection} invoiceId={sale.invoiceId ?? null} />;
}

function Inner({ status, invoiceId }: { status: "pending" | "rejected"; invoiceId: string | null }) {
  const dict = useDictionary();
  const { canView } = useCollectionsAccess();
  const href = canView && invoiceId ? `/collections?invoice=${encodeURIComponent(invoiceId)}` : undefined;
  return (
    <CollectionPill
      status={status}
      href={href}
      title={href ? dict.app.collections.detail.openInCollections : undefined}
    />
  );
}
