"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Toast } from "@/components/ui/Toast";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type EventType =
  | "sale.created"
  | "purchase.received"
  | "inventory.low_stock"
  | "payment.deferred_settled"
  | "leave.requested";

interface Pref {
  eventType: EventType;
  inApp: boolean;
  email: boolean;
  digestMode: "instant" | "digest";
  isDefault: boolean;
}

interface Payload {
  role: "owner" | "staff";
  preferences: Pref[];
}

export default function NotificationSettingsPage() {
  const dict = useDictionary();
  const t = dict.app.notificationSettings;
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications/preferences", {
        cache: "no-store",
      });
      if (res.ok) setData((await res.json()) as Payload);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (patch: Pref) => {
      setSavingKey(patch.eventType);
      // Optimistic update — reflect the change instantly, roll back on failure.
      setData((prev) =>
        prev
          ? {
              ...prev,
              preferences: prev.preferences.map((p) =>
                p.eventType === patch.eventType
                  ? { ...patch, isDefault: false }
                  : p,
              ),
            }
          : prev,
      );
      const res = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: patch.eventType,
          inApp: patch.inApp,
          email: patch.email,
          digestMode: patch.digestMode,
        }),
      });
      setSavingKey(null);
      if (!res.ok) {
        setToast({ type: "error", message: t.errorToast });
        // Reload to pick up the true state.
        void load();
        return;
      }
      setToast({ type: "success", message: t.savedToast });
      // Re-fetch so isDefault flips accurately (server may have deleted the
      // row if the patch matched the code default).
      void load();
    },
    [load, t.errorToast, t.savedToast],
  );

  if (loading || !data) {
    return (
      <AppShell title={t.title}>
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      </AppShell>
    );
  }

  const events = t.events as Record<
    EventType,
    { title: string; hint: string }
  >;

  return (
    <AppShell title={t.title}>
      <div className="max-w-3xl mx-auto space-y-5">
        <header>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-0.5">{t.intro}</p>
          <p className="text-xs text-text-secondary mt-2">
            {t.role[data.role]}
          </p>
        </header>

        <section className="rounded-2xl border border-border bg-white overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-4 py-2 border-b border-border bg-bg-main/40 text-xs font-semibold text-text-secondary">
            <div>{t.headers.event}</div>
            <div className="text-center min-w-14">{t.headers.inApp}</div>
            <div className="text-center min-w-14">{t.headers.email}</div>
            <div className="text-center min-w-24">{t.headers.delivery}</div>
          </div>
          {data.preferences.map((p) => {
            const meta = events[p.eventType];
            return (
              <div
                key={p.eventType}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-4 py-3 border-b border-border last:border-b-0"
              >
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    {meta?.title ?? p.eventType}
                    {p.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-main text-text-secondary">
                        {t.defaultBadge}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {meta?.hint}
                  </p>
                </div>
                <div className="text-center">
                  <ToggleSwitch
                    value={p.inApp}
                    disabled={savingKey === p.eventType}
                    onChange={(v) => save({ ...p, inApp: v })}
                  />
                </div>
                <div className="text-center">
                  <ToggleSwitch
                    value={p.email}
                    disabled={savingKey === p.eventType}
                    onChange={(v) => save({ ...p, email: v })}
                  />
                </div>
                <div className="text-center">
                  <select
                    disabled={!p.email || savingKey === p.eventType}
                    value={p.digestMode}
                    onChange={(e) =>
                      save({
                        ...p,
                        digestMode: e.target.value as "instant" | "digest",
                      })
                    }
                    className="text-xs px-2 py-1 rounded-md border border-border bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="instant">{t.delivery.instant}</option>
                    <option value="digest">{t.delivery.digest}</option>
                  </select>
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}

function ToggleSwitch({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`inline-flex h-6 w-10 items-center rounded-full transition-colors ${
        value ? "bg-primary" : "bg-bg-main"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          value ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}
