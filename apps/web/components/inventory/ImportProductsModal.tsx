"use client";

import { useCallback, useRef, useState } from "react";
import {
  Upload,
  Download,
  AlertCircle,
  CheckCircle,
  X,
  Info,
} from "@/lib/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

// Bulk product import — drop-zone upload → server preview → confirm.
//
// Two-phase UX so the cashier never imports something they don't understand:
//   1. Upload CSV → server parses & validates → modal shows a preview table
//      with create/update/error tags per row.
//   2. If everything is clean OR the cashier is happy with what's shown, the
//      confirm button POSTs the same CSV with mode=commit. Server re-validates
//      + writes in a single tx.
//
// Templates: the inline template link downloads a CSV pre-populated with this
// branch's category keys so the cashier has a working starting point instead
// of a blank file.

interface ImportRowError {
  row: number;
  field: string | null;
  message: string;
}

interface ImportRowPlan {
  row: number;
  action: "create" | "update" | "error";
  raw: Record<string, string>;
  errors: ImportRowError[];
}

interface ImportPreview {
  rows: number;
  toCreate: number;
  toUpdate: number;
  errored: number;
  plans: ImportRowPlan[];
}

interface ImportResult extends ImportPreview {
  created: number;
  updated: number;
  failed: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful commit so the inventory page re-fetches. */
  onImported: () => void | Promise<void>;
}

export function ImportProductsModal({ isOpen, onClose, onImported }: Props) {
  const dict = useDictionary();
  const t = dict.app.inventory.import;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const reset = useCallback(() => {
    setCsvText(null);
    setFilename(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    setPreview(null);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError(t.errors.tooLarge);
      return;
    }
    const text = await file.text();
    setCsvText(text);
    setFilename(file.name);
    setBusy(true);
    try {
      const res = await fetch("/api/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preview", csv: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed (${res.status})`);
      }
      const json = (await res.json()) as ImportPreview;
      setPreview(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errors.readFailed);
    } finally {
      setBusy(false);
    }
  }, [t.errors]);

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const commit = async () => {
    if (!csvText || !preview || preview.errored > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/products/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "commit", csv: csvText }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed (${res.status})`);
      }
      const json = (await res.json()) as ImportResult;
      setResult(json);
      if (json.created > 0 || json.updated > 0) {
        await onImported();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errors.importFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t.title}
      className="max-w-3xl"
    >
      <div className="space-y-4">
        {/* Result confirmation */}
        {result && (
          <div className="rounded-xl border border-success/30 bg-success-light p-4 text-sm text-success">
            <div className="flex items-center gap-2 font-bold mb-1">
              <CheckCircle className="w-5 h-5" />
              {t.result.success}
            </div>
            <p
              dangerouslySetInnerHTML={{
                __html: (result.failed > 0 ? t.result.summaryWithFailed : t.result.summary)
                  .replace("{created}", String(result.created))
                  .replace("{updated}", String(result.updated))
                  .replace("{failed}", String(result.failed)),
              }}
            />
            <Button
              onClick={handleClose}
              variant="secondary"
              className="mt-3"
            >
              {t.result.close}
            </Button>
          </div>
        )}

        {/* Inline guideline — what the columns mean */}
        {!result && (
          <div className="rounded-xl border border-accent-light bg-accent-light/30 p-3 text-xs space-y-2">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <p className="font-semibold text-text-primary">
                  {t.guide.heading}
                </p>
                <ul className="list-disc list-inside space-y-0.5 text-text-secondary leading-relaxed">
                  <li>
                    <code className="text-accent">name, category, price, quantity</code>{" "}
                    {t.guide.required}
                  </li>
                  <li>
                    <code className="text-accent">sku</code>{" "}
                    {t.guide.skuHint}
                  </li>
                  <li>
                    <code className="text-accent">brand, cost_price, low_stock_threshold, supplier, location, tags</code>{" "}
                    {t.guide.optional}
                  </li>
                  <li>
                    <code className="text-accent">attribute_values</code>{" "}
                    {t.guide.attributeValuesHint}{" "}
                    <code>key=label;key2=label2</code>
                    {t.guide.attributeValuesExample}{" "}
                    <code dir="auto">gender=رجالي</code>.
                  </li>
                  <li>
                    <code className="text-accent">category</code>{" "}
                    {t.guide.categoryHint}{" "}
                    (<code>watches</code>) {t.guide.categoryHintOr}{" "}
                    (<code dir="auto">ساعات</code>).
                  </li>
                </ul>
                <a
                  href="/api/products/import/template"
                  className="inline-flex items-center gap-1 mt-1 text-accent hover:underline"
                >
                  <Download className="w-3.5 h-3.5" />
                  {t.guide.templateLink}
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Upload zone */}
        {!result && !preview && (
          <div
            onDrop={onDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            className={`border-2 border-dashed rounded-2xl p-10 text-center transition-colors ${
              dragOver
                ? "border-accent bg-accent-light/30"
                : "border-border bg-bg-main/30"
            }`}
          >
            <Upload className="w-10 h-10 text-text-secondary mx-auto mb-3" />
            <p className="text-sm text-text-secondary">
              {t.drop.instructionLine}
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="mt-3 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
            >
              {busy ? t.drop.checking : t.drop.chooseFile}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <p className="text-[11px] text-text-secondary mt-3">
              {t.drop.footnote}
            </p>
          </div>
        )}

        {/* Generic error */}
        {error && (
          <div className="rounded-lg bg-danger-light text-danger text-sm p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Preview table */}
        {!result && preview && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm">
                <span className="text-text-secondary">{t.preview.fileLabel}</span>{" "}
                <span className="font-medium" dir="auto">{filename}</span>
              </p>
              <button
                type="button"
                onClick={reset}
                className="text-xs text-text-secondary hover:text-danger inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                {t.preview.resetCta}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <Stat label={t.preview.stats.create} value={preview.toCreate} tone="success" />
              <Stat label={t.preview.stats.update} value={preview.toUpdate} tone="accent" />
              <Stat
                label={t.preview.stats.error}
                value={preview.errored}
                tone={preview.errored > 0 ? "danger" : "default"}
              />
            </div>

            <div className="border border-border rounded-xl overflow-hidden max-h-[40vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-bg-main/40 sticky top-0">
                  <tr className="text-text-secondary">
                    <th className="px-3 py-2 text-start font-medium">{t.preview.table.row}</th>
                    <th className="px-3 py-2 text-start font-medium">{t.preview.table.status}</th>
                    <th className="px-3 py-2 text-start font-medium">{t.preview.table.name}</th>
                    <th className="px-3 py-2 text-start font-medium">{t.preview.table.category}</th>
                    <th className="px-3 py-2 text-end font-medium">{t.preview.table.price}</th>
                    <th className="px-3 py-2 text-end font-medium">{t.preview.table.quantity}</th>
                    <th className="px-3 py-2 text-start font-medium">{t.preview.table.notes}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.plans.map((p) => (
                    <tr
                      key={p.row}
                      className={
                        p.action === "error"
                          ? "bg-danger-light/40"
                          : p.action === "update"
                            ? "bg-accent-light/30"
                            : ""
                      }
                    >
                      <td className="px-3 py-2 tabular-nums text-text-secondary">
                        {p.row}
                      </td>
                      <td className="px-3 py-2">
                        <ActionPill action={p.action} t={t.action} />
                      </td>
                      <td className="px-3 py-2 truncate max-w-[180px]" dir="auto">
                        {p.raw.name || "—"}
                      </td>
                      <td className="px-3 py-2 truncate max-w-[100px]" dir="auto">
                        {p.raw.category || "—"}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">
                        {p.raw.price || "—"}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">
                        {p.raw.quantity || "—"}
                      </td>
                      <td className="px-3 py-2 text-danger" dir="auto">
                        {p.errors.map((e) => e.message).join(" · ") || ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.errored > 0 && (
              <div className="rounded-lg bg-orange-50 border border-orange-200 text-orange-800 text-xs p-3 leading-relaxed">
                {t.preview.errorBanner.replace("{n}", String(preview.errored))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="text-sm text-text-secondary hover:text-text-primary px-3 py-2"
              >
                {dict.app.common.cancel}
              </button>
              <Button
                onClick={commit}
                disabled={
                  busy || preview.errored > 0 || preview.rows === 0
                }
                loading={busy}
              >
                <CheckCircle className="w-4 h-4 me-1" />
                {t.preview.commit.replace(
                  "{n}",
                  String(preview.toCreate + preview.toUpdate),
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "accent" | "danger" | "default";
}) {
  const palette = {
    success: "bg-success-light text-success",
    accent: "bg-accent-light/40 text-accent",
    danger: "bg-danger-light text-danger",
    default: "bg-bg-main/40 text-text-secondary",
  }[tone];
  return (
    <div className={`rounded-lg p-3 ${palette}`}>
      <p className="text-2xl font-extrabold tabular-nums">{value}</p>
      <p className="text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}

function ActionPill({
  action,
  t,
}: {
  action: ImportRowPlan["action"];
  t: { create: string; update: string; error: string };
}) {
  const map = {
    create: { label: t.create, cls: "bg-success-light text-success" },
    update: { label: t.update, cls: "bg-accent-light/60 text-accent" },
    error: { label: t.error, cls: "bg-danger-light text-danger" },
  };
  const it = map[action];
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${it.cls}`}>
      {it.label}
    </span>
  );
}
