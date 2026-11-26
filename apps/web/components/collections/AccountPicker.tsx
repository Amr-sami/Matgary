"use client";

import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { cn } from "@/lib/utils";
import { accountIdentity, type AccountLike } from "./rules";

/**
 * Receiving-account radio list (doc 15 spec 12 §4.3 item 1): 44 px rows with
 * a visible focus ring, label + provider + identity (LTR). Rows are
 * `<testIdPrefix><accountId>` — `pos-collection-account-`,
 * `pos-collection-part-<n>-account-`, `settle-collection-account-`,
 * `collection-edit-account-`.
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
  testIdPrefix,
  disabled,
  name,
  ariaLabel,
}: {
  accounts: readonly AccountLike[];
  value: string | null;
  onChange: (id: string) => void;
  testIdPrefix: string;
  disabled?: boolean;
  /** Radio group name (unique per picker on the page). */
  name: string;
  ariaLabel?: string;
}) {
  const dict = useDictionary();
  const providers = dict.app.collections.vocab.providers as Record<string, string>;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="space-y-1.5">
      {accounts.map((a) => {
        const selected = a.id === value;
        const identity = accountIdentity(a);
        return (
          <label
            key={a.id}
            data-testid={`${testIdPrefix}${a.id}`}
            className={cn(
              "flex items-center gap-3 min-h-11 px-3 py-2 rounded-lg border cursor-pointer transition-colors",
              "focus-within:ring-2 focus-within:ring-accent",
              selected ? "border-accent bg-accent-light/60" : "border-border bg-white hover:border-accent/50",
              disabled && "opacity-60 cursor-not-allowed",
            )}
          >
            <input
              type="radio"
              name={name}
              value={a.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(a.id)}
              className="w-4 h-4 accent-accent shrink-0"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-text-primary truncate" dir="auto">
                {a.label}
              </span>
              <span className="block text-[11px] text-text-secondary truncate">
                {providers[a.provider] ?? a.provider}
                {identity && (
                  <>
                    {" · "}
                    <span dir="ltr" className="tabular-nums">
                      {identity}
                    </span>
                  </>
                )}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
