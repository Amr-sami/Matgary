"use client";

import { useState } from "react";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { cn } from "@/lib/utils";
import type { CollectionSettings } from "@/lib/api/collections";
import { useUpdateCollectionSettings } from "@/hooks/useCollections";
import type { CollectionSettingsPatch } from "@matgary/api-client/endpoints/collections";

function Switch({
  testId,
  value,
  onChange,
  disabled,
  label,
}: {
  testId: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        "relative inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <span className={cn("inline-flex h-6 w-10 items-center rounded-full transition-colors", value ? "bg-accent" : "bg-gray-300")}>
        <span
          className={cn(
            "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
            value ? "translate-x-5 rtl:-translate-x-5" : "translate-x-1 rtl:-translate-x-1",
          )}
        />
      </span>
    </button>
  );
}

function SwitchRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        {hint && <p className="text-xs text-text-secondary mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * The branch switches (doc 15 spec 12 §4.8, 09 §4.3 item 3): one PATCH per
 * change, optimistic with rollback and a toast. Recording on/off, required
 * account, the stale threshold (15–1440, saved on blur) and — with ingest —
 * auto-confirm and full payer names.
 */
export function CollectionSwitchesCard({
  branchId,
  settings,
  ingestOn,
  onToast,
}: {
  branchId: string | null;
  settings: CollectionSettings;
  ingestOn: boolean;
  onToast: (type: "success" | "error", message: string) => void;
}) {
  const dict = useDictionary();
  const t = dict.app.collectionsSettings;
  const update = useUpdateCollectionSettings(branchId);
  // Optimistic: the pending patch shows at once; on success the query data
  // (setQueryData in the hook) takes over, on failure it rolls back.
  const [pending, setPending] = useState<CollectionSettingsPatch | null>(null);
  const local: CollectionSettings = { ...settings, ...(pending ?? {}) };
  // null = show the saved value; a string = what the owner is typing.
  const [staleDraft, setStaleDraft] = useState<string | null>(null);
  const staleInput = staleDraft ?? String(local.collectionsStaleAfterMinutes);
  const [staleInvalid, setStaleInvalid] = useState(false);

  const save = async (patch: CollectionSettingsPatch) => {
    setPending(patch);
    try {
      await update.mutateAsync(patch);
      onToast("success", t.saved);
    } catch {
      onToast("error", t.saveFailed);
    } finally {
      setPending(null);
    }
  };

  const saveStale = () => {
    const raw = staleInput.trim();
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!Number.isInteger(n) || n < 15 || n > 1440) {
      setStaleInvalid(true);
      return;
    }
    setStaleInvalid(false);
    setStaleDraft(null);
    if (n !== local.collectionsStaleAfterMinutes) void save({ collectionsStaleAfterMinutes: n });
  };

  return (
    <section className="bg-white rounded-2xl border border-border p-5">
      <p className="text-sm text-text-secondary">{t.intro}</p>
      <div className="divide-y divide-border mt-2">
        <SwitchRow label={t.switches.enabled.label} hint={t.switches.enabled.hint}>
          <Switch
            testId="collections-settings-enabled"
            label={t.switches.enabled.label}
            value={local.collectionsEnabled}
            disabled={update.isPending}
            onChange={(v) => void save({ collectionsEnabled: v })}
          />
        </SwitchRow>
        {local.collectionsEnabled && (
          <>
            <SwitchRow label={t.switches.requireAccount.label} hint={t.switches.requireAccount.hint}>
              <Switch
                testId="collections-settings-require_account"
                label={t.switches.requireAccount.label}
                value={local.collectionsRequireAccount}
                disabled={update.isPending}
                onChange={(v) => void save({ collectionsRequireAccount: v })}
              />
            </SwitchRow>
            <div className="py-3">
              <label className="block">
                <span className="block text-sm font-semibold text-text-primary">{t.switches.staleAfter.label}</span>
                <span className="block text-xs text-text-secondary mt-0.5">{t.switches.staleAfter.hint}</span>
                <input
                  data-testid="collections-settings-stale_after_minutes"
                  inputMode="numeric"
                  dir="ltr"
                  value={staleInput}
                  onChange={(e) => setStaleDraft(e.target.value)}
                  onBlur={saveStale}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="mt-2 w-32 min-h-11 px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </label>
              {staleInvalid && (
                <p role="alert" className="text-[11px] text-danger mt-1">
                  {t.switches.staleAfter.invalid}
                </p>
              )}
            </div>
            {ingestOn && (
              <>
                <SwitchRow label={t.switches.autoConfirm.label} hint={t.switches.autoConfirm.hint}>
                  <Switch
                    testId="collections-settings-auto_confirm_enabled"
                    label={t.switches.autoConfirm.label}
                    value={local.collectionsAutoConfirmEnabled}
                    disabled={update.isPending}
                    onChange={(v) => void save({ collectionsAutoConfirmEnabled: v })}
                  />
                </SwitchRow>
                <SwitchRow label={t.switches.payerNames.label} hint={t.switches.payerNames.hint}>
                  <Switch
                    testId="collections-settings-store_payer_names"
                    label={t.switches.payerNames.label}
                    value={local.collectionsStorePayerNames}
                    disabled={update.isPending}
                    onChange={(v) => void save({ collectionsStorePayerNames: v })}
                  />
                </SwitchRow>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
