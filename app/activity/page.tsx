"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { History } from "@/lib/icons";
import { can } from "@/lib/permissions";
import {
  formatActivityDetails,
  ACTIVITY_CATEGORIES,
  type ActivityCategory,
  type ActivityCopy,
} from "@/lib/activity-labels";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatDate, formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";

interface LogRow {
  id: string;
  action: string;
  category: string;
  actorUserId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface Actor {
  userId: string;
  name: string;
}

const PAGE_SIZE = 50;

function formatRelative(
  iso: string,
  locale: Locale,
  copy: { now: string; minutes: string; hours: string; days: string },
): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return copy.now;
  const min = Math.floor(sec / 60);
  if (min < 60) return copy.minutes.replace("{n}", String(min));
  const hr = Math.floor(min / 60);
  if (hr < 24) return copy.hours.replace("{n}", String(hr));
  const days = Math.floor(hr / 24);
  if (days < 30) return copy.days.replace("{n}", String(days));
  return formatDate(new Date(iso), locale);
}

export default function ActivityPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.activity;
  const { data: session, status } = useSession();
  const principal = session?.user
    ? { role: session.user.role, permissions: session.user.permissions }
    : null;
  const allowed = can(principal, "view_activity_log");

  const [rows, setRows] = useState<LogRow[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [actor, setActor] = useState<string>("");
  const [category, setCategory] = useState<string>("");

  const buildQuery = useCallback(
    (before?: string) => {
      const p = new URLSearchParams();
      if (from) p.set("from", new Date(from).toISOString());
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        p.set("to", end.toISOString());
      }
      if (actor) p.set("actor", actor);
      if (category) p.set("category", category);
      if (before) p.set("before", before);
      p.set("limit", String(PAGE_SIZE));
      return p.toString();
    },
    [from, to, actor, category],
  );

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/activity?${buildQuery()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(t.errors.loadFailed);
      const data = (await res.json()) as { rows: LogRow[]; actors: Actor[] };
      setRows(data.rows);
      setActors(data.actors);
      setHasMore(data.rows.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errors.generic);
    } finally {
      setLoading(false);
    }
  }, [allowed, buildQuery, t.errors]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const last = rows[rows.length - 1];
      const res = await fetch(`/api/activity?${buildQuery(last.createdAt)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(t.errors.loadMoreFailed);
      const data = (await res.json()) as { rows: LogRow[] };
      setRows((prev) => [...prev, ...data.rows]);
      setHasMore(data.rows.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.errors.generic);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (status === "authenticated") load();
  }, [status, load]);

  const reset = () => {
    setFrom("");
    setTo("");
    setActor("");
    setCategory("");
  };

  const categoryLabels = dict.app.activityLabels.categories;
  const actionLabels = dict.app.activityLabels.actions;
  const activityCopy: ActivityCopy = useMemo(
    () => ({
      fields: dict.app.activityLabels.fields,
      fieldNames: dict.app.activityLabels.fieldNames,
      paymentMethods: dict.app.activityLabels.paymentMethods,
      payTypes: dict.app.activityLabels.payTypes,
      attendanceTypes: dict.app.activityLabels.attendanceTypes,
      attendanceSources: dict.app.activityLabels.attendanceSources,
      expenseCategories: dict.app.activityLabels.expenseCategories,
      accuracySuffix: dict.app.activityLabels.accuracySuffix,
    }),
    [dict.app.activityLabels],
  );
  const categoryOptions = useMemo(
    () => [
      { value: "", label: t.filters.allCategories },
      ...ACTIVITY_CATEGORIES.map((k) => ({
        value: k,
        label: categoryLabels[k],
      })),
    ],
    [t.filters.allCategories, categoryLabels],
  );

  const actorOptions = useMemo(
    () => [
      { value: "", label: t.filters.allUsers },
      ...actors.map((a) => ({ value: a.userId, label: a.name })),
    ],
    [actors, t.filters.allUsers],
  );

  return (
    <AppShell title={t.title}>
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            {t.heading}
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            {t.subhead}
          </p>
        </header>

        {!allowed && status === "authenticated" && (
          <div className="bg-bg-card border border-border rounded-xl p-8 text-center text-text-secondary">
            {t.notAllowed}
          </div>
        )}

        {allowed && (
          <>
            {/* Filters */}
            <div className="bg-bg-card border border-border rounded-xl p-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Input
                  type="date"
                  label={t.filters.fromLabel}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <Input
                  type="date"
                  label={t.filters.toLabel}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
                <Select
                  label={t.filters.userLabel}
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                  options={actorOptions}
                />
                <Select
                  label={t.filters.categoryLabel}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  options={categoryOptions}
                />
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="secondary" onClick={reset} type="button">
                  {t.filters.clear}
                </Button>
                <Button onClick={load} type="button" loading={loading}>
                  {t.filters.apply}
                </Button>
              </div>
            </div>

            {error && (
              <div className="bg-danger-light text-danger rounded-lg p-3 text-sm">
                {error}
              </div>
            )}

            {/* List */}
            <div className="bg-bg-card border border-border rounded-xl divide-y divide-border">
              {loading && rows.length === 0 ? (
                <div className="p-8 text-center text-text-secondary text-sm">
                  {t.loading}
                </div>
              ) : rows.length === 0 ? (
                <div className="p-8 text-center">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-bg-main flex items-center justify-center">
                    <History className="w-7 h-7 text-text-secondary" />
                  </div>
                  <p className="text-sm text-text-secondary">
                    {t.empty}
                  </p>
                </div>
              ) : (
                rows.map((r) => (
                  <ActivityRow
                    key={r.id}
                    row={r}
                    locale={locale}
                    relativeCopy={t.relative}
                    actionLabels={actionLabels}
                    categoryLabels={categoryLabels}
                    activityCopy={activityCopy}
                  />
                ))
              )}
            </div>

            {hasMore && rows.length > 0 && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  onClick={loadMore}
                  loading={loadingMore}
                  type="button"
                >
                  {t.loadMore}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

function ActivityRow({
  row,
  locale,
  relativeCopy,
  actionLabels,
  categoryLabels,
  activityCopy,
}: {
  row: LogRow;
  locale: Locale;
  relativeCopy: { now: string; minutes: string; hours: string; days: string };
  actionLabels: Record<string, string>;
  categoryLabels: Record<ActivityCategory, string>;
  activityCopy: ActivityCopy;
}) {
  const actionLabel = actionLabels[row.action] ?? row.action;
  const categoryLabel =
    categoryLabels[row.category as ActivityCategory] ?? row.category;
  const details = formatActivityDetails(row.action, row.metadata, activityCopy);

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs px-2 py-0.5 rounded-full bg-bg-main text-text-secondary">
          {categoryLabel}
        </span>
        <span className="text-sm font-medium text-text-primary">
          {actionLabel}
        </span>
        {row.entityLabel && (
          <span className="text-sm text-text-secondary truncate" dir="auto">
            — {row.entityLabel}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-text-secondary flex items-center gap-2 flex-wrap">
        <span dir="auto">{row.actorName ?? "—"}</span>
        <span>•</span>
        <time dateTime={row.createdAt} title={formatDateTime(new Date(row.createdAt), locale)}>
          {formatRelative(row.createdAt, locale, relativeCopy)}
        </time>
      </div>
      {details.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          {details.map((d, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <dt className="text-text-secondary shrink-0">{d.label}:</dt>
              <dd className="text-text-primary font-medium truncate" dir="auto">
                {d.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
