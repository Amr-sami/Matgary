"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Toast } from "@/components/ui/Toast";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface ExtraRecipient {
  name: string;
  phone?: string | null;
  email?: string | null;
  locale?: "ar" | "en" | null;
}

interface DigestSettings {
  enabled: boolean;
  digestHour: number;
  ownerPhone: string | null;
  sendOnEmpty: boolean;
  emailFallback: boolean;
  extraRecipients: ExtraRecipient[];
  managersSubscribed: string[];
}

interface BranchOpt {
  id: string;
  name: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export default function DigestSettingsPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.digestSettings;
  const [settings, setSettings] = useState<DigestSettings | null>(null);
  const [branches, setBranches] = useState<BranchOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  const [previewBranch, setPreviewBranch] = useState<string>("");
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [phoneInput, setPhoneInput] = useState<string>("");
  const [phoneDirty, setPhoneDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, bRes] = await Promise.all([
        fetch("/api/digest/settings", { cache: "no-store" }),
        fetch("/api/branches", { cache: "no-store" }),
      ]);
      if (sRes.ok) {
        const j: { settings: DigestSettings } = await sRes.json();
        setSettings(j.settings);
        setPhoneInput(j.settings.ownerPhone ?? "");
        setPhoneDirty(false);
      }
      if (bRes.ok) {
        const j: { data: BranchOpt[] } = await bRes.json();
        setBranches(j.data);
        if (j.data[0]) setPreviewBranch(j.data[0].id);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (patch: Partial<DigestSettings>) => {
    const res = await fetch("/api/digest/settings", {
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

  const preview = async () => {
    if (!previewBranch) return;
    const res = await fetch(
      `/api/digest/preview?branchId=${previewBranch}&locale=${locale}`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      setToast({ type: "error", message: t.previewErrorToast });
      return;
    }
    const j: { message: string } = await res.json();
    setPreviewText(j.message);
    setPreviewOpen(true);
  };

  if (loading || !settings) {
    return (
      <AppShell title={t.title}>
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      </AppShell>
    );
  }

  return (
    <AppShell title={t.title}>
      <div className="max-w-2xl mx-auto space-y-5">
        <header>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-0.5">{t.intro}</p>
        </header>

        {/* Enable toggle */}
        <section className="rounded-2xl border border-border bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">{t.enable.title}</h2>
              <p className="text-xs text-text-secondary mt-1">
                {settings.enabled
                  ? t.enable.onLine.replace(
                      "{hour}",
                      String(settings.digestHour).padStart(2, "0"),
                    )
                  : t.enable.offLine}
              </p>
            </div>
            <Button
              variant={settings.enabled ? "secondary" : "primary"}
              size="sm"
              onClick={() => save({ enabled: !settings.enabled })}
            >
              {settings.enabled ? t.enable.disable : t.enable.enable}
            </Button>
          </div>
        </section>

        {/* Owner / manager phone */}
        <section className="rounded-2xl border border-border bg-white p-5 space-y-3">
          <h2 className="text-base font-semibold">{t.phone.title}</h2>
          <p className="text-xs text-text-secondary">{t.phone.intro}</p>
          <div className="flex items-end gap-2">
            <Input
              label={t.phone.label}
              placeholder={t.phone.placeholder}
              dir="ltr"
              value={phoneInput}
              onChange={(e) => {
                setPhoneInput(e.target.value);
                setPhoneDirty(true);
              }}
              className="flex-1"
            />
            <Button
              size="sm"
              disabled={!phoneDirty}
              onClick={async () => {
                await save({ ownerPhone: phoneInput.trim() || null });
                setPhoneDirty(false);
              }}
            >
              {t.phone.save}
            </Button>
          </div>
        </section>

        {/* Schedule */}
        <section className="rounded-2xl border border-border bg-white p-5 space-y-3">
          <h2 className="text-base font-semibold">{t.schedule.title}</h2>
          <p className="text-xs text-text-secondary">{t.schedule.intro}</p>
          <Select
            label={t.schedule.hourLabel}
            options={HOURS.map((h) => ({
              value: String(h),
              label: `${String(h).padStart(2, "0")}:00`,
            }))}
            value={String(settings.digestHour)}
            onChange={(e) => save({ digestHour: Number(e.target.value) })}
          />
        </section>

        {/* Behavior */}
        <section className="rounded-2xl border border-border bg-white p-5 space-y-2">
          <h2 className="text-base font-semibold">{t.behavior.title}</h2>
          <ToggleRow
            label={t.behavior.sendOnEmpty}
            value={settings.sendOnEmpty}
            onChange={(v) => save({ sendOnEmpty: v })}
            onText={t.toggles.on}
            offText={t.toggles.off}
          />
          <ToggleRow
            label={t.behavior.emailFallback}
            value={settings.emailFallback}
            onChange={(v) => save({ emailFallback: v })}
            onText={t.toggles.on}
            offText={t.toggles.off}
          />
        </section>

        {/* Extra recipients */}
        <section className="rounded-2xl border border-border bg-white p-5 space-y-3">
          <h2 className="text-base font-semibold">{t.extras.title}</h2>
          <p className="text-xs text-text-secondary">{t.extras.intro}</p>
          {settings.extraRecipients.length === 0 && (
            <p className="text-sm text-text-secondary text-center py-3">
              {t.extras.empty}
            </p>
          )}
          {settings.extraRecipients.map((ex, i) => (
            <div
              key={i}
              className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end p-2 rounded-lg bg-bg-main/30"
            >
              <Input
                label={t.extras.nameLabel}
                value={ex.name}
                onChange={(e) => {
                  const next = [...settings.extraRecipients];
                  next[i] = { ...ex, name: e.target.value };
                  setSettings({ ...settings, extraRecipients: next });
                }}
              />
              <Input
                label={t.extras.phoneLabel}
                value={ex.phone ?? ""}
                onChange={(e) => {
                  const next = [...settings.extraRecipients];
                  next[i] = { ...ex, phone: e.target.value };
                  setSettings({ ...settings, extraRecipients: next });
                }}
              />
              <div className="flex gap-1">
                <Input
                  label={t.extras.emailLabel}
                  value={ex.email ?? ""}
                  onChange={(e) => {
                    const next = [...settings.extraRecipients];
                    next[i] = { ...ex, email: e.target.value };
                    setSettings({ ...settings, extraRecipients: next });
                  }}
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = settings.extraRecipients.filter(
                      (_, j) => j !== i,
                    );
                    save({ extraRecipients: next });
                  }}
                >
                  {t.extras.delete}
                </Button>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setSettings({
                  ...settings,
                  extraRecipients: [
                    ...settings.extraRecipients,
                    { name: "", phone: "", email: "", locale: "ar" },
                  ],
                })
              }
            >
              {t.extras.add}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                save({ extraRecipients: settings.extraRecipients })
              }
            >
              {t.extras.saveAll}
            </Button>
          </div>
        </section>

        {/* Preview */}
        <section className="rounded-2xl border border-border bg-white p-5 space-y-3">
          <h2 className="text-base font-semibold">{t.preview.title}</h2>
          <p className="text-xs text-text-secondary">{t.preview.intro}</p>
          <div className="flex gap-2">
            <Select
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
              value={previewBranch}
              onChange={(e) => setPreviewBranch(e.target.value)}
              className="flex-1"
            />
            <Button onClick={preview} size="sm">
              {t.preview.submit}
            </Button>
          </div>
        </section>
      </div>

      {/* Preview modal */}
      <Modal
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t.preview.modalTitle}
      >
        <pre
          dir="auto"
          className="whitespace-pre-wrap text-sm bg-bg-main/40 rounded-lg p-3 max-h-80 overflow-y-auto"
        >
          {previewText}
        </pre>
      </Modal>

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

function ToggleRow({
  label,
  value,
  onChange,
  onText,
  offText,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  onText: string;
  offText: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="w-full flex items-center justify-between py-2 text-sm"
    >
      <span>{label}</span>
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
          value
            ? "bg-success-light text-success"
            : "bg-bg-main text-text-secondary"
        }`}
      >
        {value ? onText : offText}
      </span>
    </button>
  );
}
