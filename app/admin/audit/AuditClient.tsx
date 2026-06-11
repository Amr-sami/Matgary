"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

interface AuditRow {
  id: string;
  adminId: string | null;
  adminEmail: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  beforeJsonb: Record<string, unknown> | null;
  afterJsonb: Record<string, unknown> | null;
  occurredAt: string;
}

interface AdminOption {
  id: string;
  email: string;
}

const ACTION_PREFIXES = [
  { value: "", labelKey: "actionAll" },
  { value: "auth.", labelKey: "actionAuth" },
  { value: "tenant.", labelKey: "actionTenant" },
  { value: "plan.", labelKey: "actionPlan" },
  { value: "admin.", labelKey: "actionAdmin" },
  { value: "broadcast.", labelKey: "actionBroadcast" },
  { value: "impersonate.", labelKey: "actionImpersonate" },
] as const;

const TARGET_KINDS = ["", "tenant", "plan", "broadcast", "admin"] as const;

export function AuditClient() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.audit;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<AuditRow | null>(null);
  const [admins, setAdmins] = useState<AdminOption[]>([]);

  const [actor, setActor] = useState("");
  const [actionPrefix, setActionPrefix] = useState("");
  const [targetKind, setTargetKind] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    // /api/admin/admins is super_admin-only. ops_admin will get 404 — fine,
    // we just leave the actor filter empty in that case.
    fetch("/api/admin/admins", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j: { data: AdminOption[] }) => setAdmins(j.data ?? []))
      .catch(() => setAdmins([]));
  }, []);

  // 400 ms debounce on the free-text input — keeps the search index honest.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q.length >= 3 ? q : ""), 400);
    return () => clearTimeout(id);
  }, [q]);

  const params = useMemo(() => {
    const out = new URLSearchParams();
    if (actor) out.set("actorAdminId", actor);
    if (actionPrefix) out.set("actionPrefix", actionPrefix);
    if (targetKind) out.set("targetKind", targetKind);
    if (since) out.set("since", new Date(since).toISOString());
    if (until) out.set("until", new Date(until).toISOString());
    if (debouncedQ) out.set("q", debouncedQ);
    return out;
  }, [actor, actionPrefix, targetKind, since, until, debouncedQ]);

  const load = useCallback(async (cursor: string | null = null) => {
    setLoading(true);
    try {
      const p = new URLSearchParams(params);
      if (cursor) p.set("cursor", cursor);
      const res = await fetch(`/api/admin/audit?${p.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        if (cursor) return; // ignore — keep current rows
        setRows([]);
        setNextCursor(null);
        return;
      }
      const json = (await res.json()) as {
        data: AuditRow[];
        nextCursor: string | null;
      };
      if (cursor) {
        setRows((prev) => [...prev, ...json.data]);
      } else {
        setRows(json.data);
      }
      setNextCursor(json.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header>
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
      </header>

      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-border p-4 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
        <Field label={t.filters.actor}>
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-white"
          >
            <option value="">{t.filters.actorAny}</option>
            {admins.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.filters.actionPrefix}>
          <select
            value={actionPrefix}
            onChange={(e) => setActionPrefix(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-white"
          >
            {ACTION_PREFIXES.map((a) => (
              <option key={a.value || "all"} value={a.value}>
                {(t.filters as Record<string, string>)[a.labelKey]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.filters.targetKind}>
          <select
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-white"
          >
            <option value="">{t.filters.targetKindAny}</option>
            {TARGET_KINDS.filter(Boolean).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.filters.since}>
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-white"
          />
        </Field>
        <Field label={t.filters.until}>
          <input
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-white"
          />
        </Field>
        <Field label={t.filters.q}>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.filters.qPlaceholder}
            className="w-full px-2 py-1.5 rounded-md border border-border bg-white"
          />
        </Field>
      </div>

      {/* Table */}
      {rows.length === 0 && !loading ? (
        <div className="bg-white rounded-2xl border border-border py-12 text-center">
          <p className="text-sm font-medium mb-1">{t.empty}</p>
          <p className="text-xs text-text-secondary">{t.emptyHint}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-main/40 text-xs text-text-secondary">
                <tr>
                  <th className="text-start font-medium px-3 py-2">{t.columns.time}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.actor}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.action}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.target}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.ip}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.diff}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setOpening(r)}
                    className="border-t border-border hover:bg-bg-main/30 cursor-pointer"
                  >
                    <td className="px-3 py-2 text-xs text-text-secondary whitespace-nowrap">
                      {new Date(r.occurredAt).toLocaleString(dateLocale)}
                    </td>
                    <td className="px-3 py-2 text-xs" dir="ltr">
                      {r.adminEmail ?? `${t.deletedActor} #${r.adminId?.slice(0, 6) ?? "—"}`}
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-[11px] bg-bg-main rounded px-1.5 py-0.5">
                        {r.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary" dir="ltr">
                      {r.targetKind ?? "—"}
                      {r.targetId && (
                        <span className="opacity-60"> #{r.targetId.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary" dir="ltr">
                      {r.ip ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary max-w-md truncate">
                      {summariseDiff(r, t.createdMarker, t.deletedMarker)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextCursor && (
            <div className="px-3 py-3 border-t border-border text-center">
              <button
                type="button"
                onClick={() => load(nextCursor)}
                disabled={loading}
                className="text-xs text-accent disabled:opacity-50"
              >
                {loading ? "…" : t.loadMore}
              </button>
            </div>
          )}
        </div>
      )}

      <DiffModal
        row={opening}
        t={t.modal}
        dateLocale={dateLocale}
        onClose={() => setOpening(null)}
      />
    </div>
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
      <span className="block text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}

function summariseDiff(
  row: AuditRow,
  createdLabel: string,
  deletedLabel: string,
): string {
  if (!row.beforeJsonb && !row.afterJsonb) return "—";
  if (!row.beforeJsonb) return `${createdLabel}: ${shortJson(row.afterJsonb)}`;
  if (!row.afterJsonb) return `${deletedLabel}: ${shortJson(row.beforeJsonb)}`;

  const changed: string[] = [];
  const keys = new Set<string>([
    ...Object.keys(row.beforeJsonb ?? {}),
    ...Object.keys(row.afterJsonb ?? {}),
  ]);
  for (const k of keys) {
    const a = (row.beforeJsonb ?? {})[k];
    const b = (row.afterJsonb ?? {})[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(`${k}: ${shortValue(a)} → ${shortValue(b)}`);
    }
    if (changed.length >= 2) break;
  }
  return changed.join(", ") || "—";
}

function shortValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 32 ? `${v.slice(0, 30)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 32);
}

function shortJson(o: Record<string, unknown> | null): string {
  if (!o) return "—";
  const s = JSON.stringify(o);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

interface DiffModalT {
  title: string;
  actor: string;
  action: string;
  target: string;
  occurredAt: string;
  ip: string;
  userAgent: string;
  before: string;
  after: string;
  copy: string;
  copied: string;
  close: string;
}

function DiffModal({
  row,
  t,
  dateLocale,
  onClose,
}: {
  row: AuditRow | null;
  t: DiffModalT;
  dateLocale: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!row) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ before: row.beforeJsonb, after: row.afterJsonb }, null, 2),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <Modal isOpen={!!row} onClose={onClose} title={t.title}>
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Info label={t.actor} value={row.adminEmail ?? row.adminId ?? "—"} />
          <Info label={t.action} value={row.action} mono />
          <Info
            label={t.target}
            value={`${row.targetKind ?? "—"}${row.targetId ? " #" + row.targetId : ""}`}
            mono
          />
          <Info
            label={t.occurredAt}
            value={new Date(row.occurredAt).toLocaleString(dateLocale)}
          />
          <Info label={t.ip} value={row.ip ?? "—"} mono />
          <Info label={t.userAgent} value={row.userAgent ?? "—"} mono />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 border-t border-border pt-3">
          <DiffPane label={t.before} obj={row.beforeJsonb} tone="bad" />
          <DiffPane label={t.after} obj={row.afterJsonb} tone="good" />
        </div>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={copy}>
            {copied ? t.copied : t.copy}
          </Button>
          <Button onClick={onClose}>{t.close}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Info({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] text-text-secondary uppercase tracking-wider">
        {label}
      </p>
      <p
        className={`mt-0.5 break-all ${mono ? "font-mono" : ""}`}
        dir="auto"
      >
        {value}
      </p>
    </div>
  );
}

function DiffPane({
  label,
  obj,
  tone,
}: {
  label: string;
  obj: Record<string, unknown> | null;
  tone: "bad" | "good";
}) {
  const cls =
    tone === "bad"
      ? "bg-danger-light/40 text-danger"
      : "bg-success-light/40 text-success";
  return (
    <div>
      <p className="text-[10px] text-text-secondary uppercase tracking-wider mb-1">
        {label}
      </p>
      <pre
        dir="ltr"
        className={`rounded-md p-2 text-[11px] whitespace-pre-wrap break-all max-h-72 overflow-auto ${cls}`}
      >
        {obj ? JSON.stringify(obj, null, 2) : "—"}
      </pre>
    </div>
  );
}
