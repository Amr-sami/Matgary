"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Toast } from "@/components/ui/Toast";
import { AlertCircle, AlertTriangle, Eye, Info, X } from "@/lib/icons";

type Severity = "info" | "warning" | "critical";
type Audience = "all" | "owners" | "staff";

interface Row {
  id: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string | null;
  bodyEn: string | null;
  severity: Severity;
  audience: Audience;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}

export function BroadcastsClient({ canManage }: { canManage: boolean }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.broadcasts;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Row | "new" | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/broadcasts", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { data: Row[] };
        setRows(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const now = Date.now();
    const active: Row[] = [];
    const scheduled: Row[] = [];
    const past: Row[] = [];
    for (const r of rows) {
      const starts = new Date(r.startsAt).getTime();
      const ends = r.endsAt ? new Date(r.endsAt).getTime() : null;
      if (starts > now) scheduled.push(r);
      else if (ends == null || ends > now) active.push(r);
      else past.push(r);
    }
    return { active, scheduled, past };
  }, [rows]);

  const fmtDateTime = (s: string) => new Date(s).toLocaleString(dateLocale);

  const onError = (code: string | undefined) => {
    const msg =
      (code && (t.errors as Record<string, string>)[code]) || t.toast.errorGeneric;
    setToast({ type: "error", message: msg });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
        </div>
        {canManage && <Button onClick={() => setEditor("new")}>{t.createCta}</Button>}
      </header>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      ) : (
        <>
          <Section
            title={t.sections.active}
            rows={grouped.active}
            t={t}
            locale={locale}
            fmtDateTime={fmtDateTime}
            canManage={canManage}
            onEdit={(r) => setEditor(r)}
            onEndNow={(id) => setEndingId(id)}
            emptyText={t.sections.emptyActive}
          />
          <Section
            title={t.sections.scheduled}
            rows={grouped.scheduled}
            t={t}
            locale={locale}
            fmtDateTime={fmtDateTime}
            canManage={canManage}
            onEdit={(r) => setEditor(r)}
            onEndNow={(id) => setEndingId(id)}
            emptyText={t.sections.emptyScheduled}
          />
          <Section
            title={t.sections.past}
            rows={grouped.past}
            t={t}
            locale={locale}
            fmtDateTime={fmtDateTime}
            canManage={canManage}
            onEdit={() => {}}
            onEndNow={() => {}}
            collapsed
            emptyText={t.sections.emptyPast}
          />
        </>
      )}

      <BroadcastEditor
        mode={editor === "new" ? "new" : editor ? "edit" : null}
        existing={editor !== "new" ? editor : null}
        t={t}
        onClose={() => setEditor(null)}
        onError={onError}
        onSuccess={async (createdOrEdited) => {
          setEditor(null);
          setToast({
            type: "success",
            message: createdOrEdited === "new" ? t.toast.created : t.toast.saved,
          });
          await load();
        }}
      />

      <Modal
        isOpen={!!endingId}
        onClose={() => setEndingId(null)}
        title={t.form.submitEndNow}
      >
        {endingId && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">{t.row.endNow}</p>
            <div className="flex gap-2 justify-end pt-2 border-t border-border">
              <Button variant="secondary" onClick={() => setEndingId(null)}>
                {t.form.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const res = await fetch(
                    `/api/admin/broadcasts/${endingId}/end-now`,
                    { method: "POST" },
                  );
                  if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    onError(j.error);
                    return;
                  }
                  setEndingId(null);
                  setToast({ type: "success", message: t.toast.ended });
                  await load();
                }}
              >
                {t.form.submitEndNow}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
}

interface SectionT {
  severity: Record<Severity, string>;
  audience: Record<Audience, string>;
  row: { endsIn: string; noEnd: string; startsIn: string; endedAt: string; edit: string; endNow: string };
}

function Section({
  title,
  rows,
  t,
  locale,
  fmtDateTime,
  canManage,
  onEdit,
  onEndNow,
  collapsed,
  emptyText,
}: {
  title: string;
  rows: Row[];
  t: SectionT;
  locale: "ar" | "en";
  fmtDateTime: (s: string) => string;
  canManage: boolean;
  onEdit: (r: Row) => void;
  onEndNow: (id: string) => void;
  collapsed?: boolean;
  emptyText: string;
}) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="bg-white rounded-2xl border border-border">
      <header className="px-5 py-3 border-b border-border flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-sm font-semibold inline-flex items-center gap-2"
        >
          <span>{title}</span>
          <span className="text-xs text-text-secondary">{rows.length}</span>
        </button>
      </header>
      {open && (
        <div className="divide-y divide-border">
          {rows.length === 0 ? (
            <p className="text-xs text-text-secondary text-center py-6">{emptyText}</p>
          ) : (
            rows.map((r) => (
              <article key={r.id} className="px-5 py-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <SeverityBadge severity={r.severity} t={t.severity} />
                    <AudienceBadge audience={r.audience} t={t.audience} />
                    <div className="min-w-0">
                      <h3 className="font-semibold" dir="auto">
                        {locale === "ar" ? r.titleAr : r.titleEn}
                      </h3>
                      {(locale === "ar" ? r.bodyAr : r.bodyEn) && (
                        <p
                          className="text-xs text-text-secondary mt-0.5"
                          dir="auto"
                        >
                          {locale === "ar" ? r.bodyAr : r.bodyEn}
                        </p>
                      )}
                      <p className="text-[11px] text-text-secondary mt-1" dir="ltr">
                        {fmtDateTime(r.startsAt)} →{" "}
                        {r.endsAt ? fmtDateTime(r.endsAt) : t.row.noEnd}
                      </p>
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onEdit(r)}
                        className="text-xs text-text-secondary hover:text-accent"
                      >
                        {t.row.edit}
                      </button>
                      {(!r.endsAt || new Date(r.endsAt).getTime() > Date.now()) && (
                        <button
                          type="button"
                          onClick={() => onEndNow(r.id)}
                          className="text-xs text-text-secondary hover:text-danger"
                        >
                          {t.row.endNow}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function SeverityBadge({
  severity,
  t,
}: {
  severity: Severity;
  t: Record<Severity, string>;
}) {
  const cls =
    severity === "critical"
      ? "bg-danger-light text-danger"
      : severity === "warning"
        ? "bg-orange-100 text-orange-700"
        : "bg-bg-main text-text-secondary";
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {t[severity]}
    </span>
  );
}

function AudienceBadge({
  audience,
  t,
}: {
  audience: Audience;
  t: Record<Audience, string>;
}) {
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent-light text-accent">
      {t[audience]}
    </span>
  );
}

interface EditorT {
  form: { createTitle: string; editTitle: string; submitCreate: string; submitSave: string; cancel: string };
  fields: {
    titleAr: string;
    titleEn: string;
    bodyAr: string;
    bodyEn: string;
    severityLabel: string;
    audienceLabel: string;
  };
  preview: {
    title: string;
    subtitle: string;
    asBanner: string;
    asModal: string;
    emptyTitle: string;
    emptySub: string;
    frameUrl: string;
    frameWorkspace: string;
    localeAr: string;
    localeEn: string;
    criticalBadge: string;
  };
  severity: Record<Severity, string>;
  audience: Record<Audience, string>;
  errors: Record<string, string>;
  toast: { created: string; saved: string; errorGeneric: string };
}

function BroadcastEditor({
  mode,
  existing,
  t,
  onClose,
  onError,
  onSuccess,
}: {
  mode: "new" | "edit" | null;
  existing: Row | null;
  t: EditorT;
  onClose: () => void;
  onError: (code: string | undefined) => void;
  onSuccess: (kind: "new" | "edit") => void | Promise<void>;
}) {
  const initial = existing
    ? {
        titleAr: existing.titleAr,
        titleEn: existing.titleEn,
        bodyAr: existing.bodyAr ?? "",
        bodyEn: existing.bodyEn ?? "",
        severity: existing.severity,
        audience: existing.audience,
      }
    : {
        titleAr: "",
        titleEn: "",
        bodyAr: "",
        bodyEn: "",
        severity: "info" as Severity,
        audience: "all" as Audience,
      };
  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (mode) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id, mode]);

  if (!mode) return null;

  const submit = async () => {
    setSubmitting(true);
    try {
      // No dates: server defaults startsAt to now() and leaves endsAt null
      // (open-ended). The operator ends a broadcast manually via "End now"
      // on the list.
      const body = {
        titleAr: form.titleAr.trim(),
        titleEn: form.titleEn.trim(),
        bodyAr: form.bodyAr.trim() || null,
        bodyEn: form.bodyEn.trim() || null,
        severity: form.severity,
        audience: form.audience,
      };
      const url = mode === "new" ? "/api/admin/broadcasts" : `/api/admin/broadcasts/${existing!.id}`;
      const method = mode === "new" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(j.error);
        return;
      }
      await onSuccess(mode);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={mode === "new" ? t.form.createTitle : t.form.editTitle}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={t.fields.titleAr}>
            <input
              type="text"
              dir="rtl"
              value={form.titleAr}
              onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          <Field label={t.fields.titleEn}>
            <input
              type="text"
              dir="ltr"
              value={form.titleEn}
              onChange={(e) => setForm({ ...form, titleEn: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
          <Field label={t.fields.bodyAr}>
            <textarea
              dir="rtl"
              rows={3}
              value={form.bodyAr}
              onChange={(e) => setForm({ ...form, bodyAr: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
          </Field>
          <Field label={t.fields.bodyEn}>
            <textarea
              dir="ltr"
              rows={3}
              value={form.bodyEn}
              onChange={(e) => setForm({ ...form, bodyEn: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={t.fields.severityLabel}>
            <select
              value={form.severity}
              onChange={(e) =>
                setForm({ ...form, severity: e.target.value as Severity })
              }
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="info">{t.severity.info}</option>
              <option value="warning">{t.severity.warning}</option>
              <option value="critical">{t.severity.critical}</option>
            </select>
          </Field>
          <Field label={t.fields.audienceLabel}>
            <select
              value={form.audience}
              onChange={(e) =>
                setForm({ ...form, audience: e.target.value as Audience })
              }
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="all">{t.audience.all}</option>
              <option value="owners">{t.audience.owners}</option>
              <option value="staff">{t.audience.staff}</option>
            </select>
          </Field>
        </div>

        {/* Live preview — shows the banner shape with the operator's
            current copy + severity. For `critical` we also flag that the
            tenant will see a modal popup first. */}
        <BroadcastLivePreview form={form} t={t} />

        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.form.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {mode === "new" ? t.form.submitCreate : t.form.submitSave}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Premium live preview for the broadcast editor. Shows a faux app-shell
 *  frame with the banner rendered in context, and — for critical
 *  severity — the modal popup rendered on a dimmed backdrop alongside it.
 *  Operator picks AR or EN with a tab so they can verify both locales
 *  before publishing. */
function BroadcastLivePreview({
  form,
  t,
}: {
  form: {
    titleAr: string;
    titleEn: string;
    bodyAr: string;
    bodyEn: string;
    severity: Severity;
  };
  t: EditorT;
}) {
  const locale = useLocale();
  const [previewLocale, setPreviewLocale] = useState<"ar" | "en">(locale);
  const isCritical = form.severity === "critical";

  // Mirror-on-display: if one language is empty we fall back to the other,
  // matching the server's mirror behaviour so the operator sees exactly
  // what tenants will see.
  const titleFor = (loc: "ar" | "en") => {
    const primary = (loc === "ar" ? form.titleAr : form.titleEn).trim();
    const fallback = (loc === "ar" ? form.titleEn : form.titleAr).trim();
    return primary || fallback;
  };
  const bodyFor = (loc: "ar" | "en") => {
    const primary = (loc === "ar" ? form.bodyAr : form.bodyEn).trim();
    const fallback = (loc === "ar" ? form.bodyEn : form.bodyAr).trim();
    return primary || fallback;
  };

  const title = titleFor(previewLocale);
  const body = bodyFor(previewLocale);
  const hasAnyTitle = !!(titleFor("ar") || titleFor("en"));

  const tone = severityTone(form.severity);
  const Icon = tone.Icon;

  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-bg-main/60 via-white to-bg-main/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-white/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-full bg-accent-light text-accent inline-flex items-center justify-center shrink-0">
            <Eye className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary leading-tight">
              {t.preview.title}
            </p>
            <p className="text-[10px] text-text-secondary leading-tight">
              {t.preview.subtitle}
            </p>
          </div>
        </div>
        {hasAnyTitle && (
          <div className="inline-flex rounded-full border border-border bg-white p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setPreviewLocale("ar")}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-full transition-colors ${
                previewLocale === "ar"
                  ? "bg-accent text-white"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t.preview.localeAr}
            </button>
            <button
              type="button"
              onClick={() => setPreviewLocale("en")}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-full transition-colors ${
                previewLocale === "en"
                  ? "bg-accent text-white"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t.preview.localeEn}
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4">
        {!hasAnyTitle ? (
          <div className="rounded-xl border border-dashed border-border bg-white/60 px-5 py-8 text-center">
            <span className="inline-flex w-10 h-10 rounded-full bg-accent-light text-accent items-center justify-center mb-2">
              <Eye className="w-5 h-5" />
            </span>
            <p className="text-sm font-semibold text-text-primary">
              {t.preview.emptyTitle}
            </p>
            <p className="text-xs text-text-secondary mt-1 max-w-sm mx-auto">
              {t.preview.emptySub}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {/* Banner-in-app frame — matches the real tenant banner: accent
                bar on the leading edge, icon in a tinted circle, two-tone
                surface (no saturated full-color background). */}
            <PreviewFrame
              label={t.preview.asBanner}
              frameUrl={t.preview.frameUrl}
              frameWorkspace={t.preview.frameWorkspace}
              previewLocale={previewLocale}
            >
              <div className="broadcast-glow relative overflow-hidden rounded-lg shadow-sm">
                <span
                  aria-hidden
                  className={`absolute start-0 top-0 bottom-0 w-[3px] ${tone.accentBar}`}
                />
                <div className="flex items-start gap-2 ps-3 pe-1.5 py-2">
                  <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tone.iconColor}`} />
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-[12px] font-semibold text-text-primary leading-snug"
                      dir="auto"
                    >
                      {title}
                    </p>
                    {body && (
                      <p
                        className="text-[10px] text-text-secondary leading-snug mt-0.5"
                        dir="auto"
                      >
                        {body}
                      </p>
                    )}
                  </div>
                  <X className="w-3 h-3 mt-1 shrink-0 text-text-secondary" />
                </div>
              </div>
              {/* Faux page chrome under the banner */}
              <div className="mt-3 space-y-1.5">
                <div className="h-3 w-2/3 rounded bg-bg-main" />
                <div className="h-2 w-full rounded bg-bg-main/70" />
                <div className="h-2 w-5/6 rounded bg-bg-main/70" />
                <div className="grid grid-cols-3 gap-1.5 mt-2">
                  <div className="h-8 rounded bg-bg-main/60" />
                  <div className="h-8 rounded bg-bg-main/60" />
                  <div className="h-8 rounded bg-bg-main/60" />
                </div>
              </div>
            </PreviewFrame>

            {/* Critical modal frame — gradient hero strip mirroring the
                real BroadcastModal. */}
            {isCritical ? (
              <PreviewFrame
                label={t.preview.asModal}
                frameUrl={t.preview.frameUrl}
                frameWorkspace={t.preview.frameWorkspace}
                previewLocale={previewLocale}
              >
                <div className="relative h-full min-h-[160px] rounded-lg overflow-hidden bg-bg-main/60">
                  {/* Faux app content behind the modal */}
                  <div className="absolute inset-0 p-2 space-y-1.5 opacity-60">
                    <div className="h-2 w-2/3 rounded bg-text-secondary/30" />
                    <div className="h-2 w-full rounded bg-text-secondary/20" />
                    <div className="h-2 w-5/6 rounded bg-text-secondary/20" />
                    <div className="grid grid-cols-3 gap-1.5 mt-2">
                      <div className="h-6 rounded bg-text-secondary/20" />
                      <div className="h-6 rounded bg-text-secondary/20" />
                      <div className="h-6 rounded bg-text-secondary/20" />
                    </div>
                  </div>
                  {/* Dim backdrop */}
                  <div className="absolute inset-0 bg-black/40" />
                  {/* Modal card: thin red top rail + white header + neutral
                      title — matches the calmer real BroadcastModal. */}
                  <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-lg bg-white shadow-xl border border-border overflow-hidden">
                    <div aria-hidden className="h-[3px] bg-danger" />
                    <div className="px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-danger" />
                        <div className="min-w-0">
                          <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-danger">
                            {t.preview.criticalBadge}
                          </p>
                          <p className="text-[12px] font-semibold text-text-primary leading-tight mt-0.5 truncate" dir="auto">
                            {title}
                          </p>
                        </div>
                      </div>
                      {body && (
                        <p className="text-[10px] text-text-secondary mt-1.5 leading-snug" dir="auto">
                          {body}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </PreviewFrame>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-white/40 p-4 flex items-center justify-center text-center">
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {t.preview.asModal}
                  <br />
                  <span className="opacity-60">{tone.modalEmptyHint}</span>
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Faux browser/app chrome: traffic-light dots, URL bar, workspace label,
 *  then the preview surface inside. Keeps the preview unmistakably a
 *  *mockup* rather than a real surface the operator might mis-click. */
function PreviewFrame({
  label,
  frameUrl,
  frameWorkspace,
  previewLocale,
  children,
}: {
  label: string;
  frameUrl: string;
  frameWorkspace: string;
  previewLocale: "ar" | "en";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <p className="text-[10px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
        {label}
      </p>
      <div className="flex-1 rounded-xl border border-border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-main/60 border-b border-border">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          <span className="w-2 h-2 rounded-full bg-yellow-400" />
          <span className="w-2 h-2 rounded-full bg-green-400" />
          <span className="ms-1 px-2 py-0.5 rounded-md bg-white text-[10px] text-text-secondary border border-border min-w-0 truncate" dir="ltr">
            {frameUrl}
          </span>
        </div>
        <div className="px-2.5 py-1 bg-white/80 border-b border-border">
          <p className="text-[9px] text-text-secondary uppercase tracking-wider">
            {frameWorkspace}
          </p>
        </div>
        <div className="p-2.5" dir={previewLocale === "ar" ? "rtl" : "ltr"}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Per-severity palette for the preview — mirrors the tenant banner:
 *  white surface, color only on the accent rail and icon. */
function severityTone(severity: Severity): {
  Icon: typeof Info;
  accentBar: string;
  iconColor: string;
  modalEmptyHint: string;
} {
  if (severity === "critical") {
    return {
      Icon: AlertCircle,
      accentBar: "bg-danger",
      iconColor: "text-danger",
      modalEmptyHint: "—",
    };
  }
  if (severity === "warning") {
    return {
      Icon: AlertTriangle,
      accentBar: "bg-amber-500",
      iconColor: "text-amber-600",
      modalEmptyHint: "warning · banner only",
    };
  }
  return {
    Icon: Info,
    accentBar: "bg-slate-400",
    iconColor: "text-slate-500",
    modalEmptyHint: "info · banner only",
  };
}
