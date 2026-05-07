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
  ACTION_LABELS,
  CATEGORY_LABELS,
  formatActivityDetails,
  type ActivityCategory,
} from "@/lib/activity-labels";

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

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "الآن";
  const min = Math.floor(sec / 60);
  if (min < 60) return `منذ ${min} دقيقة`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `منذ ${hr} ساعة`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `منذ ${days} يوم`;
  return new Date(iso).toLocaleDateString("ar-EG");
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString("ar-EG", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export default function ActivityPage() {
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
      if (!res.ok) throw new Error("تعذر تحميل السجل");
      const data = (await res.json()) as { rows: LogRow[]; actors: Actor[] };
      setRows(data.rows);
      setActors(data.actors);
      setHasMore(data.rows.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطأ غير معروف");
    } finally {
      setLoading(false);
    }
  }, [allowed, buildQuery]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoadingMore(true);
    try {
      const last = rows[rows.length - 1];
      const res = await fetch(`/api/activity?${buildQuery(last.createdAt)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("تعذر تحميل المزيد");
      const data = (await res.json()) as { rows: LogRow[] };
      setRows((prev) => [...prev, ...data.rows]);
      setHasMore(data.rows.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطأ غير معروف");
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

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "كل الأقسام" },
      ...(Object.keys(CATEGORY_LABELS) as ActivityCategory[]).map((k) => ({
        value: k,
        label: CATEGORY_LABELS[k],
      })),
    ],
    [],
  );

  const actorOptions = useMemo(
    () => [
      { value: "", label: "كل المستخدمين" },
      ...actors.map((a) => ({ value: a.userId, label: a.name })),
    ],
    [actors],
  );

  return (
    <AppShell title="سجل النشاط">
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary leading-tight">
            سجل النشاط
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            كل العمليات التي تتم في النظام — من أضاف، عدّل، أو حذف.
          </p>
        </header>

        {!allowed && status === "authenticated" && (
          <div className="bg-bg-card border border-border rounded-xl p-8 text-center text-text-secondary">
            ليس لديك صلاحية لعرض السجل.
          </div>
        )}

        {allowed && (
          <>
            {/* Filters */}
            <div className="bg-bg-card border border-border rounded-xl p-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Input
                  type="date"
                  label="من تاريخ"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <Input
                  type="date"
                  label="إلى تاريخ"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
                <Select
                  label="المستخدم"
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                  options={actorOptions}
                />
                <Select
                  label="القسم"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  options={categoryOptions}
                />
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="secondary" onClick={reset} type="button">
                  مسح
                </Button>
                <Button onClick={load} type="button" loading={loading}>
                  تطبيق
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
                  جاري التحميل…
                </div>
              ) : rows.length === 0 ? (
                <div className="p-8 text-center">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-bg-main flex items-center justify-center">
                    <History className="w-7 h-7 text-text-secondary" />
                  </div>
                  <p className="text-sm text-text-secondary">
                    لا توجد عمليات مسجلة في هذه الفترة.
                  </p>
                </div>
              ) : (
                rows.map((r) => <ActivityRow key={r.id} row={r} />)
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
                  تحميل المزيد
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

function ActivityRow({ row }: { row: LogRow }) {
  const actionLabel = ACTION_LABELS[row.action] ?? row.action;
  const categoryLabel =
    CATEGORY_LABELS[row.category as ActivityCategory] ?? row.category;
  const details = formatActivityDetails(row.action, row.metadata);

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
          <span className="text-sm text-text-secondary truncate">
            — {row.entityLabel}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-text-secondary flex items-center gap-2 flex-wrap">
        <span>{row.actorName ?? "—"}</span>
        <span>•</span>
        <time dateTime={row.createdAt} title={formatAbsolute(row.createdAt)}>
          {formatRelative(row.createdAt)}
        </time>
      </div>
      {details.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          {details.map((d, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <dt className="text-text-secondary shrink-0">{d.label}:</dt>
              <dd className="text-text-primary font-medium truncate">
                {d.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
