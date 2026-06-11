"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast } from "@/components/ui/Toast";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface ShopSettingsRow {
  branchId: string;
  branchName: string;
  cashReconciliationEnabled: boolean;
  cashVarianceNoteThreshold: string;
}

export default function CashDrawerSettingsPage() {
  const dict = useDictionary();
  const t = dict.app.cashDrawerSettings;
  const [rows, setRows] = useState<ShopSettingsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/cash-drawer", {
        cache: "no-store",
      });
      if (res.ok) {
        const json: { data: ShopSettingsRow[] } = await res.json();
        setRows(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (branchId: string, patch: Partial<ShopSettingsRow>) => {
    const res = await fetch(`/api/settings/cash-drawer?branchId=${branchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      setToast({ type: "error", message: t.errorToast });
      return;
    }
    setToast({ type: "success", message: t.savedToast });
    await load();
  };

  return (
    <AppShell title={t.title}>
      <div className="max-w-3xl mx-auto space-y-5">
        <header>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-0.5">{t.intro}</p>
        </header>

        {loading ? (
          <p className="text-sm text-text-secondary text-center py-8">…</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <section
                key={r.branchId}
                className="rounded-2xl border border-border bg-white p-5 space-y-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{r.branchName}</h2>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {r.cashReconciliationEnabled ? t.enabled : t.disabled}
                    </p>
                  </div>
                  <Button
                    variant={r.cashReconciliationEnabled ? "secondary" : "primary"}
                    size="sm"
                    onClick={() =>
                      save(r.branchId, {
                        cashReconciliationEnabled: !r.cashReconciliationEnabled,
                      })
                    }
                  >
                    {r.cashReconciliationEnabled ? t.disable : t.enable}
                  </Button>
                </div>
                <Input
                  label={t.thresholdLabel}
                  type="number"
                  min={0}
                  step="0.01"
                  value={r.cashVarianceNoteThreshold}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((row) =>
                        row.branchId === r.branchId
                          ? { ...row, cashVarianceNoteThreshold: e.target.value }
                          : row,
                      ),
                    )
                  }
                  onBlur={() =>
                    save(r.branchId, {
                      cashVarianceNoteThreshold: r.cashVarianceNoteThreshold,
                    })
                  }
                />
              </section>
            ))}
          </div>
        )}
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
