"use client";

import Link from "next/link";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { cn } from "@/lib/utils";
import { pillTone, type PillStatus } from "./rules";

/**
 * The shared collection status pill (doc 15 spec 12 §4.10): tone from
 * `pillTone()`, label `app.collections.vocab.status.<status>`, root
 * `data-testid="collection-badge-<status>"`. With `href` it is a link (the
 * sales list and ledger deep-link into the inbox for `view_collections`).
 */
export function CollectionPill({
  status,
  href,
  title,
  className,
}: {
  status: PillStatus;
  href?: string;
  title?: string;
  className?: string;
}) {
  const dict = useDictionary();
  const label = (dict.app.collections.vocab.status as Record<string, string>)[status] ?? status;
  const cls = cn(
    "inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap",
    pillTone(status),
    className,
  );
  if (href) {
    return (
      <Link
        href={href}
        title={title}
        data-testid={`collection-badge-${status}`}
        className={cn(
          cls,
          // A 44 px tall hit area around the small pill (visual size unchanged).
          "relative before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']",
          "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Link>
    );
  }
  return (
    <span data-testid={`collection-badge-${status}`} title={title} className={cls}>
      {label}
    </span>
  );
}
