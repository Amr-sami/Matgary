"use client";

import { useState } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import { useCollectionDevices } from "@/hooks/useCollections";
import type { CollectionAccount, DeviceDTO } from "@/lib/api/collections";
import { useOnline } from "./CollectionDetailModal";
import { HEALTH_TONE_CLASS, deviceHealthTone, splitDevices } from "./rules";
import { cn } from "@/lib/utils";

/**
 * Linked phones (doc 15 spec 12 §4.8, M2): `GET /api/collections/devices`
 * rows `collection-device-<id>` with 07's server-computed health (never
 * recomputed here), revoke `collection-device-revoke-<id>` → confirm →
 * `DELETE`. Phones unlinked in the last 30 days are greyed under
 * `recentlyUnlinked`. The web lists and revokes; it never creates (Q8 —
 * setup and device creation are phone-only).
 */
export function DevicesCard({
  accounts,
  onToast,
}: {
  accounts: CollectionAccount[];
  onToast: (type: "success" | "error", message: string) => void;
}) {
  const dict = useDictionary();
  const t = dict.app.collections.web.devices;
  const { list, revoke } = useCollectionDevices(true);
  const online = useOnline();
  const [target, setTarget] = useState<DeviceDTO | null>(null);
  const devices = list.data?.devices ?? [];
  const { live, revoked } = splitDevices(devices);

  const doRevoke = async () => {
    if (!target) return;
    try {
      await revoke.mutateAsync(target.id);
      onToast("success", t.revoked);
    } catch {
      onToast("error", t.revokeFailed);
    }
  };

  return (
    <section data-testid="collection-devices" className="bg-white rounded-2xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary">{t.title}</h2>
        <p className="text-xs text-text-secondary">{t.subtitle}</p>
      </div>
      {list.isPending ? (
        <PageSkeleton variant="list" rows={2} />
      ) : list.isError ? (
        <div className="p-6 text-center space-y-3">
          <p className="text-sm text-text-secondary">{dict.app.collections.inbox.loadFailed}</p>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            {dict.app.collections.web.inbox.retry}
          </Button>
        </div>
      ) : (
        <>
          {live.length === 0 ? (
            <p data-testid="collection-devices-empty" className="px-4 py-6 text-center text-sm text-text-secondary">
              {t.empty}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {live.map((d) => (
                <DeviceRow
                  key={d.id}
                  d={d}
                  accounts={accounts}
                  revokeDisabled={!online || revoke.isPending}
                  onRevoke={() => setTarget(d)}
                />
              ))}
            </ul>
          )}
          {revoked.length > 0 && (
            <div className="border-t border-border">
              <h3 className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
                {t.recentlyUnlinked}
              </h3>
              <ul className="divide-y divide-border opacity-60">
                {revoked.map((d) => (
                  <DeviceRow key={d.id} d={d} accounts={accounts} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        isOpen={target != null}
        onClose={() => setTarget(null)}
        onConfirm={doRevoke}
        title={t.revokeTitle.replace("{label}", target?.label ?? "")}
        message={t.revokeBody}
        confirmText={t.revoke}
        loading={revoke.isPending}
      />
    </section>
  );
}

function DeviceRow({
  d,
  accounts,
  revokeDisabled,
  onRevoke,
}: {
  d: DeviceDTO;
  accounts: CollectionAccount[];
  revokeDisabled?: boolean;
  onRevoke?: () => void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.collections.web.devices;
  const health = t.health as Record<string, string>;
  const platform = t.platform as Record<string, string>;
  const accountNames =
    d.accountIds.length === 0
      ? t.accountsAll
      : d.accountIds.map((id) => accounts.find((a) => a.id === id)?.label ?? "•••").join(" · ");

  return (
    <li data-testid={`collection-device-${d.id}`} className="px-4 py-3 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary" dir="auto">
            {d.label}
          </span>
          <span
            data-testid={`collection-device-health-${d.health}`}
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap",
              HEALTH_TONE_CLASS[deviceHealthTone(d.health)],
            )}
          >
            {health[d.health] ?? d.health}
          </span>
        </div>
        <p className="text-[11px] text-text-secondary flex flex-wrap gap-x-2">
          <span>{platform[d.platform] ?? d.platform}</span>
          <span dir="ltr" className="font-mono">
            {t.token.replace("{prefix}", d.tokenPrefix)}
          </span>
          <span dir="auto">{accountNames}</span>
        </p>
        <p className="text-[11px] text-text-secondary flex flex-wrap gap-x-2">
          {d.createdBy?.name && (
            <span>{t.linkedBy.replace("{name}", d.createdBy.name).replace("{date}", formatDate(d.createdAt, locale))}</span>
          )}
          {d.lastMessageAt ? (
            <span>{t.lastMessage.replace("{date}", formatDateTime(d.lastMessageAt, locale))}</span>
          ) : (
            <span>{t.never}</span>
          )}
          {d.lastCreditAt && <span>{t.lastCredit.replace("{date}", formatDateTime(d.lastCreditAt, locale))}</span>}
        </p>
      </div>
      {onRevoke && !d.revokedAt && (
        <Button
          variant="ghost"
          data-testid={`collection-device-revoke-${d.id}`}
          className="min-h-11 lg:min-h-0 text-danger"
          disabled={revokeDisabled}
          onClick={onRevoke}
        >
          {t.revoke}
        </Button>
      )}
    </li>
  );
}
