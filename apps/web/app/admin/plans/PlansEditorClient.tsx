"use client";

import { useCallback, useEffect, useState } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Toast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

interface PlanRow {
  key: string;
  labelAr: string;
  labelEn: string;
  taglineAr: string;
  taglineEn: string;
  monthlyEgp: number;
  purchasable: boolean;
  featuresAr: string[];
  featuresEn: string[];
  sortOrder: number;
  updatedAt: string;
  updatedByEmail: string | null;
}

export function PlansEditorClient() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.plans;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [rows, setRows] = useState<PlanRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, PlanRow>>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/plans", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { data: PlanRow[] };
        setRows(json.data);
        setDrafts(
          Object.fromEntries(json.data.map((r) => [r.key, { ...r }])),
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateDraft = (key: string, patch: Partial<PlanRow>) =>
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header>
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
      </header>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      ) : (
        rows.map((row) => (
          <PlanCard
            key={row.key}
            row={row}
            draft={drafts[row.key]}
            t={t}
            dateLocale={dateLocale}
            previewLocale={locale}
            onChange={(patch) => updateDraft(row.key, patch)}
            onSaved={async (msg) => {
              setToast({ type: "success", message: msg });
              await load();
            }}
            onError={(msg) => setToast({ type: "error", message: msg })}
          />
        ))
      )}

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
}

interface PlanCardT {
  title: string;
  subtitle: string;
  lastEditedBy: string;
  lastEditedAnon: string;
  fields: {
    labelAr: string;
    labelEn: string;
    taglineAr: string;
    taglineEn: string;
    monthlyEgp: string;
    purchasable: string;
    purchasableHint: string;
    sortOrder: string;
    featuresAr: string;
    featuresEn: string;
    addFeature: string;
    featurePlaceholder: string;
    removeFeature: string;
  };
  preview: { title: string; switchLocale: string };
  actions: {
    save: string;
    saving: string;
    savedToast: string;
    discard: string;
    diffTitle: string;
    diffIntro: string;
    diffCancel: string;
    diffConfirm: string;
  };
  errors: {
    stale: string;
    localePairRequired: string;
    invalidPrice: string;
    generic: string;
  };
}

function PlanCard({
  row,
  draft,
  t,
  dateLocale,
  previewLocale,
  onChange,
  onSaved,
  onError,
}: {
  row: PlanRow;
  draft: PlanRow;
  t: PlanCardT;
  dateLocale: string;
  previewLocale: "ar" | "en";
  onChange: (patch: Partial<PlanRow>) => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify(row) !== JSON.stringify(draft);

  const computePatch = (): Partial<PlanRow> => {
    const out: Partial<PlanRow> = {};
    if (draft.labelAr !== row.labelAr) out.labelAr = draft.labelAr;
    if (draft.labelEn !== row.labelEn) out.labelEn = draft.labelEn;
    if (draft.taglineAr !== row.taglineAr) out.taglineAr = draft.taglineAr;
    if (draft.taglineEn !== row.taglineEn) out.taglineEn = draft.taglineEn;
    if (draft.monthlyEgp !== row.monthlyEgp) out.monthlyEgp = draft.monthlyEgp;
    if (draft.purchasable !== row.purchasable) out.purchasable = draft.purchasable;
    if (JSON.stringify(draft.featuresAr) !== JSON.stringify(row.featuresAr))
      out.featuresAr = draft.featuresAr;
    if (JSON.stringify(draft.featuresEn) !== JSON.stringify(row.featuresEn))
      out.featuresEn = draft.featuresEn;
    if (draft.sortOrder !== row.sortOrder) out.sortOrder = draft.sortOrder;
    return out;
  };

  const submit = async () => {
    setSaving(true);
    try {
      // Enforce the AR/EN pair on the client so the user gets a nice message
      // instead of bouncing off the server's 400.
      const patch = computePatch();
      const pairs: [keyof PlanRow, keyof PlanRow][] = [
        ["labelAr", "labelEn"],
        ["taglineAr", "taglineEn"],
        ["featuresAr", "featuresEn"],
      ];
      for (const [a, b] of pairs) {
        if ((a in patch) !== (b in patch)) {
          patch[a] = draft[a] as never;
          patch[b] = draft[b] as never;
        }
      }
      const res = await fetch(`/api/admin/plans/${row.key}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "If-Match": row.updatedAt,
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.error === "STALE") onError(t.errors.stale);
        else if (j.error === "LOCALE_PAIR_REQUIRED")
          onError(t.errors.localePairRequired);
        else if (j.error === "INVALID_PRICE") onError(t.errors.invalidPrice);
        else onError(t.errors.generic);
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      await onSaved(t.actions.savedToast);
    } finally {
      setSaving(false);
    }
  };

  const lastEdited =
    row.updatedByEmail != null
      ? t.lastEditedBy
          .replace("{email}", row.updatedByEmail)
          .replace("{when}", new Date(row.updatedAt).toLocaleString(dateLocale))
      : t.lastEditedAnon.replace(
          "{when}",
          new Date(row.updatedAt).toLocaleString(dateLocale),
        );

  return (
    <>
      <section className="bg-white rounded-2xl border border-border p-5 space-y-5">
        <header>
          <h2 className="text-lg font-bold" dir="auto">
            {draft.labelEn} <span className="text-text-secondary text-sm">· {row.key}</span>
          </h2>
          <p className="text-xs text-text-secondary mt-0.5">{lastEdited}</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TextField
            label={t.fields.labelAr}
            dir="rtl"
            value={draft.labelAr}
            onChange={(v) => onChange({ labelAr: v })}
          />
          <TextField
            label={t.fields.labelEn}
            dir="ltr"
            value={draft.labelEn}
            onChange={(v) => onChange({ labelEn: v })}
          />
          <TextField
            label={t.fields.taglineAr}
            dir="rtl"
            value={draft.taglineAr}
            onChange={(v) => onChange({ taglineAr: v })}
          />
          <TextField
            label={t.fields.taglineEn}
            dir="ltr"
            value={draft.taglineEn}
            onChange={(v) => onChange({ taglineEn: v })}
          />
          <TextField
            label={t.fields.monthlyEgp}
            type="number"
            value={String(draft.monthlyEgp)}
            onChange={(v) => onChange({ monthlyEgp: Number(v) || 0 })}
          />
          <TextField
            label={t.fields.sortOrder}
            type="number"
            value={String(draft.sortOrder)}
            onChange={(v) => onChange({ sortOrder: Number(v) || 0 })}
          />
        </div>

        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.purchasable}
              onChange={(e) => onChange({ purchasable: e.target.checked })}
            />
            <span>{t.fields.purchasable}</span>
          </label>
          <span className="text-xs text-text-secondary">
            {t.fields.purchasableHint}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FeatureList
            label={t.fields.featuresAr}
            placeholder={t.fields.featurePlaceholder}
            addLabel={t.fields.addFeature}
            removeLabel={t.fields.removeFeature}
            dir="rtl"
            items={draft.featuresAr}
            onChange={(items) => onChange({ featuresAr: items })}
          />
          <FeatureList
            label={t.fields.featuresEn}
            placeholder={t.fields.featurePlaceholder}
            addLabel={t.fields.addFeature}
            removeLabel={t.fields.removeFeature}
            dir="ltr"
            items={draft.featuresEn}
            onChange={(items) => onChange({ featuresEn: items })}
          />
        </div>

        {/* Live preview */}
        <div className="border-t border-border pt-4">
          <p className="text-xs text-text-secondary uppercase tracking-wider mb-2">
            {t.preview.title}
          </p>
          <PlanPreview plan={draft} locale={previewLocale} />
        </div>

        <footer className="flex justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => onChange({ ...row })}
          >
            {t.actions.discard}
          </Button>
          <Button disabled={!dirty || saving} onClick={() => setConfirmOpen(true)}>
            {saving ? t.actions.saving : t.actions.save}
          </Button>
        </footer>
      </section>

      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t.actions.diffTitle}
      >
        <div className="space-y-3 text-sm">
          <p className="text-text-secondary">{t.actions.diffIntro}</p>
          <DiffTable row={row} draft={draft} t={t} />
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              {t.actions.diffCancel}
            </Button>
            <Button onClick={submit} loading={saving}>
              {t.actions.diffConfirm}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  dir,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  dir?: "ltr" | "rtl";
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">
        {label}
      </span>
      <input
        type={type}
        dir={dir}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </label>
  );
}

function FeatureList({
  label,
  placeholder,
  addLabel,
  removeLabel,
  items,
  onChange,
  dir,
}: {
  label: string;
  placeholder: string;
  addLabel: string;
  removeLabel: string;
  items: string[];
  onChange: (next: string[]) => void;
  dir?: "ltr" | "rtl";
}) {
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary mb-1">{label}</p>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5 items-start">
            <input
              type="text"
              dir={dir}
              value={it}
              placeholder={placeholder}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
              className="flex-1 px-2 py-1.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="px-2 py-1.5 text-xs text-text-secondary hover:text-danger"
            >
              {removeLabel}
            </button>
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                disabled={i === 0}
                onClick={() => {
                  const next = [...items];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(next);
                }}
                className="text-xs text-text-secondary hover:text-accent disabled:opacity-30"
                aria-label="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === items.length - 1}
                onClick={() => {
                  const next = [...items];
                  [next[i], next[i + 1]] = [next[i + 1], next[i]];
                  onChange(next);
                }}
                className="text-xs text-text-secondary hover:text-accent disabled:opacity-30"
                aria-label="Move down"
              >
                ▼
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...items, ""])}
        className="mt-2 text-xs text-accent"
      >
        + {addLabel}
      </button>
    </div>
  );
}

function PlanPreview({ plan, locale }: { plan: PlanRow; locale: "ar" | "en" }) {
  const label = locale === "ar" ? plan.labelAr : plan.labelEn;
  const tagline = locale === "ar" ? plan.taglineAr : plan.taglineEn;
  const features = locale === "ar" ? plan.featuresAr : plan.featuresEn;
  return (
    <div
      className="bg-bg-main/40 rounded-xl p-5 max-w-sm border border-border"
      dir={locale === "ar" ? "rtl" : "ltr"}
    >
      <h3 className="text-lg font-bold">{label}</h3>
      <p className="text-xs text-text-secondary mt-0.5">{tagline}</p>
      <p className="text-3xl font-extrabold text-accent mt-3" dir="ltr">
        ₤{plan.monthlyEgp}
        <span className="text-sm font-normal text-text-secondary ms-1">
          / {locale === "ar" ? "شهر" : "month"}
        </span>
      </p>
      <ul className="mt-3 space-y-1 text-sm">
        {features.map((f, i) => (
          <li key={i}>• {f}</li>
        ))}
      </ul>
    </div>
  );
}

function DiffTable({
  row,
  draft,
  t,
}: {
  row: PlanRow;
  draft: PlanRow;
  t: PlanCardT;
}) {
  const FIELDS: [keyof PlanRow, string][] = [
    ["labelAr", t.fields.labelAr],
    ["labelEn", t.fields.labelEn],
    ["taglineAr", t.fields.taglineAr],
    ["taglineEn", t.fields.taglineEn],
    ["monthlyEgp", t.fields.monthlyEgp],
    ["purchasable", t.fields.purchasable],
    ["sortOrder", t.fields.sortOrder],
    ["featuresAr", t.fields.featuresAr],
    ["featuresEn", t.fields.featuresEn],
  ];
  const changed = FIELDS.filter(([f]) => {
    const a = row[f];
    const b = draft[f];
    return Array.isArray(a) ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
  });
  if (changed.length === 0) {
    return <p className="text-xs text-text-secondary">—</p>;
  }
  return (
    <ul className="space-y-2">
      {changed.map(([f, label]) => (
        <li key={String(f)} className="text-xs">
          <p className="font-medium text-text-primary">{label}</p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <pre className="bg-danger-light/60 text-danger rounded p-2 whitespace-pre-wrap break-words" dir="auto">
              {JSON.stringify(row[f])}
            </pre>
            <pre className="bg-success-light/60 text-success rounded p-2 whitespace-pre-wrap break-words" dir="auto">
              {JSON.stringify(draft[f])}
            </pre>
          </div>
        </li>
      ))}
    </ul>
  );
}
