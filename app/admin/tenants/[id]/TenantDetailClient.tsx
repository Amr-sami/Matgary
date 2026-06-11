"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { SuspendTenantModal } from "@/components/admin/SuspendTenantModal";
import { UnsuspendTenantModal } from "@/components/admin/UnsuspendTenantModal";
import { ExtendTrialModal } from "@/components/admin/ExtendTrialModal";
import { ImpersonationConfirmModal } from "@/components/admin/ImpersonationConfirmModal";
import { Toast } from "@/components/ui/Toast";

interface HealthFlag {
  key: string;
  severity: "ok" | "warn";
  value: number;
}

interface SalesPerformance {
  ytd: { gross: string; count: number };
  yoyPct: number | null;
  thisMonth: { gross: string; count: number };
  series12mo: { month: string; gross: string; count: number }[];
  topBranches: { branchId: string; name: string; gross: string; count: number }[];
  topProducts: { productName: string; gross: string; qty: number }[];
  paymentMix: { cash: string; card: string; instapay: string; deferred: string };
}

interface Detail {
  tenant: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    suspendedAt: string | null;
    suspendedReason: string | null;
    deletionScheduledAt: string | null;
  };
  owner: {
    userId: string;
    name: string | null;
    email: string;
    phone: string | null;
  } | null;
  subscription: {
    plan: string;
    status: string;
    trialEndsAt: string;
    currentPeriodEndsAt: string | null;
    cancelledAt: string | null;
    amountEgp: string | null;
  } | null;
  lastPayment: {
    amountEgp: string;
    status: string;
    attemptedAt: string;
    failureReason: string | null;
  } | null;
  failedAttempts90d: number;
  branches: {
    id: string;
    name: string;
    isActive: boolean;
    employeeCount: number;
    lastSaleAt: string | null;
  }[];
  counts: {
    employees: number;
    branches: number;
    salesLast30d: number;
  };
  resolvedStatus: string;
  healthFlags: HealthFlag[];
  salesPerformance: SalesPerformance | null;
}

interface ActivityRow {
  id: string;
  actorName: string | null;
  action: string;
  category: string;
  entityLabel: string | null;
  createdAt: string;
}

export function TenantDetailClient({ id }: { id: string }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.tenants.detail;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [data, setData] = useState<Detail | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [unsuspendOpen, setUnsuspendOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [impersonateOpen, setImpersonateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, a] = await Promise.all([
        fetch(`/api/admin/tenants/${id}`, { cache: "no-store" }).then((r) =>
          r.ok ? r.json() : null,
        ),
        fetch(`/api/admin/tenants/${id}/activity?limit=10`, { cache: "no-store" }).then(
          (r) => (r.ok ? r.json() : { data: [] }),
        ),
      ]);
      setData(d);
      setActivity(a?.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-text-secondary text-center py-8">{t.loading}</p>;
  }
  if (!data) {
    return (
      <p className="text-sm text-text-secondary text-center py-8">{t.notFound}</p>
    );
  }

  const sub = data.subscription;
  const lp = data.lastPayment;
  const formatDate = (s: string) => new Date(s).toLocaleDateString(dateLocale);

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <Link href="/admin/tenants" className="text-sm text-accent">
        {t.back}
      </Link>

      {/* Suspended banner */}
      {data.tenant.suspendedAt && (
        <div className="bg-danger-light text-danger rounded-2xl p-4">
          <p className="font-bold text-sm">⛔ {t.suspendedBanner.title}</p>
          <p className="text-xs mt-1">
            {formatDate(data.tenant.suspendedAt)} ·{" "}
            {data.tenant.suspendedReason
              ? t.suspendedBanner.reason.replace(
                  "{reason}",
                  data.tenant.suspendedReason,
                )
              : t.suspendedBanner.noReason}
          </p>
        </div>
      )}

      {/* Identity header */}
      <header className="bg-white rounded-2xl border border-border p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold" dir="auto">
              {data.tenant.name}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5" dir="ltr">
              {data.tenant.slug}
            </p>
            {data.owner && (
              <div className="mt-2 text-sm space-y-0.5">
                <p dir="auto">{data.owner.name ?? "—"}</p>
                <p dir="ltr" className="text-xs text-text-secondary">
                  {data.owner.email} · {data.owner.phone ?? "—"}
                </p>
              </div>
            )}
            <p className="text-xs text-text-secondary mt-2">
              {t.createdAt.replace("{date}", formatDate(data.tenant.createdAt))}
            </p>
          </div>
          {/* Action buttons — Spec 03 wires suspend / unsuspend / extend
              trial. Impersonate remains disabled until Spec 07. */}
          <div className="flex flex-wrap gap-2">
            {data.tenant.suspendedAt ? (
              <ActionButton
                onClick={() => setUnsuspendOpen(true)}
                tone="primary"
              >
                {t.actions.unsuspend}
              </ActionButton>
            ) : (
              <ActionButton
                onClick={() => setSuspendOpen(true)}
                tone="danger"
              >
                {t.actions.suspend}
              </ActionButton>
            )}
            <ActionButton
              onClick={() => setExtendOpen(true)}
              disabled={data.subscription?.status !== "trialing"}
              title={
                data.subscription?.status !== "trialing"
                  ? t.actions.extendModal.errorNotTrialing
                  : undefined
              }
            >
              {t.actions.extendTrial}
            </ActionButton>
            <ActionButton
              onClick={() => setImpersonateOpen(true)}
              disabled={!!data.tenant.suspendedAt}
              title={
                data.tenant.suspendedAt
                  ? t.actions.impersonateModal.errors.TENANT_SUSPENDED
                  : undefined
              }
              tone="danger"
            >
              {t.actions.impersonate}
            </ActionButton>
            <Link
              href={`/admin/tenants/${data.tenant.id}/activity`}
              className="inline-flex h-9 px-3 rounded-lg border border-border bg-white text-text-secondary text-xs items-center hover:border-accent hover:text-accent"
            >
              {t.actions.viewActivity}
            </Link>
          </div>
        </div>
      </header>

      {/* Plan & billing */}
      <section className="bg-white rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold mb-3">{t.billing.title}</h2>
        {sub ? (
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-text-secondary">{t.billing.title}: </span>
              <span className="font-medium">{sub.plan}</span>
              {sub.amountEgp && Number(sub.amountEgp) > 0 && (
                <span className="text-text-secondary" dir="ltr">
                  {" "}
                  · ₤{Number(sub.amountEgp).toLocaleString("en-US")} {t.billing.perMonth}
                </span>
              )}
            </p>
            <p className="text-xs text-text-secondary">
              {sub.status === "trialing"
                ? t.billing.trialEndsOn.replace("{date}", formatDate(sub.trialEndsAt))
                : sub.currentPeriodEndsAt
                  ? t.billing.renewalOn.replace(
                      "{date}",
                      formatDate(sub.currentPeriodEndsAt),
                    )
                  : ""}
            </p>
            <div className="pt-2 border-t border-border mt-2">
              <p className="text-text-secondary text-xs">{t.billing.lastPayment}</p>
              {lp ? (
                <p className="text-sm mt-0.5" dir="ltr">
                  ₤{Number(lp.amountEgp).toLocaleString("en-US")} · {lp.status} ·{" "}
                  {formatDate(lp.attemptedAt)}
                </p>
              ) : (
                <p className="text-xs mt-0.5">{t.billing.lastPaymentNone}</p>
              )}
              <p className="text-xs text-text-secondary mt-1">
                {t.billing.failedAttempts.replace(
                  "{n}",
                  String(data.failedAttempts90d),
                )}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-secondary">—</p>
        )}
      </section>

      {/* Branches */}
      <section className="bg-white rounded-2xl border border-border overflow-hidden">
        <header className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">
            {t.branches.title.replace("{n}", String(data.branches.length))}
          </h2>
        </header>
        <table className="w-full text-sm">
          <thead className="bg-bg-main/40">
            <tr className="text-xs text-text-secondary">
              <th className="text-start font-medium px-4 py-2">
                {t.branches.name}
              </th>
              <th className="text-start font-medium px-4 py-2">Status</th>
              <th className="text-end font-medium px-4 py-2">
                {t.branches.employees}
              </th>
              <th className="text-start font-medium px-4 py-2">
                {t.branches.lastSale}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.branches.map((b) => (
              <tr key={b.id} className="border-t border-border">
                <td className="px-4 py-2" dir="auto">
                  {b.name}
                </td>
                <td className="px-4 py-2 text-xs">
                  <span
                    className={`px-2 py-0.5 rounded-full ${
                      b.isActive
                        ? "bg-success-light text-success"
                        : "bg-bg-main text-text-secondary"
                    }`}
                  >
                    {b.isActive ? t.branches.active : t.branches.inactive}
                  </span>
                </td>
                <td className="px-4 py-2 text-end tabular-nums">
                  {b.employeeCount}
                </td>
                <td className="px-4 py-2 text-xs text-text-secondary">
                  {b.lastSaleAt ? formatDate(b.lastSaleAt) : t.branches.none}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Sales performance — Spec 09. Only renders when there's a
          subscription row and the BYPASSRLS query returned data; for a
          fresh tenant with zero sales the chart and lists silently
          collapse to "—" so the section stays useful. */}
      {data.salesPerformance && (
        <SalesPerformanceSection
          perf={data.salesPerformance}
          t={dict.app.admin.sales.tenantDetail}
        />
      )}

      {/* Health flags */}
      <section className="bg-white rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold mb-3">{t.healthFlags.title}</h2>
        <ul className="space-y-1.5 text-sm">
          {data.healthFlags.map((f) => {
            const labelTpl =
              (t.healthFlags as Record<string, string>)[f.key] ?? f.key;
            const label = labelTpl.replace("{n}", String(f.value));
            return (
              <li
                key={f.key}
                className={`flex items-start gap-2 ${
                  f.severity === "warn" ? "text-orange-700" : "text-success"
                }`}
              >
                <span className="shrink-0">{f.severity === "ok" ? "✓" : "⚠"}</span>
                <span>{label}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Recent activity */}
      <section className="bg-white rounded-2xl border border-border p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">{t.activity.title}</h2>
          <Link
            href={`/admin/tenants/${data.tenant.id}/activity`}
            className="text-xs text-accent"
          >
            {t.activity.viewAll}
          </Link>
        </div>
        {activity.length === 0 ? (
          <p className="text-xs text-text-secondary text-center py-4">
            {t.activity.empty}
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {activity.map((a) => (
              <li key={a.id} className="py-2.5">
                <p className="flex items-center gap-2">
                  <span className="font-mono text-[11px] bg-bg-main rounded px-1.5 py-0.5">
                    {a.action}
                  </span>
                  {a.entityLabel && (
                    <span className="text-text-secondary text-xs" dir="auto">
                      {a.entityLabel}
                    </span>
                  )}
                </p>
                <p className="text-xs text-text-secondary mt-1">
                  {a.actorName ?? "—"} · {formatDate(a.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SuspendTenantModal
        isOpen={suspendOpen}
        tenantName={data.tenant.name}
        tenantId={data.tenant.id}
        onClose={() => setSuspendOpen(false)}
        onSuccess={async () => {
          setSuspendOpen(false);
          setToast({ type: "success", message: t.actions.suspendModal.successToast });
          await load();
        }}
        onError={(m) => setToast({ type: "error", message: m })}
      />
      <UnsuspendTenantModal
        isOpen={unsuspendOpen}
        tenantName={data.tenant.name}
        tenantId={data.tenant.id}
        onClose={() => setUnsuspendOpen(false)}
        onSuccess={async () => {
          setUnsuspendOpen(false);
          setToast({ type: "success", message: t.actions.unsuspendModal.successToast });
          await load();
        }}
        onError={(m) => setToast({ type: "error", message: m })}
      />
      {data.subscription && (
        <ExtendTrialModal
          isOpen={extendOpen}
          tenantName={data.tenant.name}
          tenantId={data.tenant.id}
          currentTrialEndsAt={data.subscription.trialEndsAt}
          onClose={() => setExtendOpen(false)}
          onSuccess={async () => {
            setExtendOpen(false);
            setToast({ type: "success", message: t.actions.extendModal.successToast });
            await load();
          }}
          onError={(m) => setToast({ type: "error", message: m })}
        />
      )}
      <ImpersonationConfirmModal
        isOpen={impersonateOpen}
        tenantId={data.tenant.id}
        tenantName={data.tenant.name}
        onClose={() => setImpersonateOpen(false)}
        onError={(m) => setToast({ type: "error", message: m })}
      />
      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
}

function DisabledButton({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      disabled
      title={title}
      className="inline-flex h-9 px-3 rounded-lg border border-border bg-white text-text-secondary text-xs items-center cursor-not-allowed opacity-60"
    >
      {children}
    </button>
  );
}

function ActionButton({
  children,
  onClick,
  tone,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "primary" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const cls =
    tone === "danger"
      ? "border-danger text-danger hover:bg-danger-light"
      : tone === "primary"
        ? "border-accent text-accent hover:bg-accent-light"
        : "border-border text-text-secondary hover:border-accent hover:text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-9 px-3 rounded-lg border bg-white text-xs items-center disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
    >
      {children}
    </button>
  );
}

interface SalesPerfT {
  title: string;
  ytdLabel: string;
  yoyLabel: string;
  thisMonthLabel: string;
  chartTitle: string;
  topBranches: string;
  topProducts: string;
  paymentMix: string;
  paymentMethods: { cash: string; card: string; instapay: string; deferred: string };
  noBranches: string;
  noProducts: string;
}

function SalesPerformanceSection({
  perf,
  t,
}: {
  perf: SalesPerformance;
  t: SalesPerfT;
}) {
  const fmtCurrencyFull = (s: string) =>
    `₤${Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtCurrencyShort = (s: string) =>
    `₤${Number(s).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <section className="bg-white rounded-2xl border border-border p-5 space-y-4">
      <h2 className="text-sm font-semibold">{t.title}</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-xl bg-bg-main/40 p-4">
          <p className="text-[11px] text-text-secondary uppercase tracking-wider">
            {t.ytdLabel}
          </p>
          <p className="text-xl font-bold mt-1" dir="ltr">
            {fmtCurrencyFull(perf.ytd.gross)}
          </p>
          {perf.yoyPct != null && (
            <p
              className={`text-[11px] mt-0.5 ${
                perf.yoyPct > 0
                  ? "text-success"
                  : perf.yoyPct < 0
                    ? "text-danger"
                    : "text-text-secondary"
              }`}
              dir="ltr"
            >
              {perf.yoyPct > 0 ? "▲" : perf.yoyPct < 0 ? "▼" : "·"}{" "}
              {Math.abs(perf.yoyPct)}% {t.yoyLabel}
            </p>
          )}
        </div>
        <div className="rounded-xl bg-bg-main/40 p-4">
          <p className="text-[11px] text-text-secondary uppercase tracking-wider">
            {t.thisMonthLabel}
          </p>
          <p className="text-xl font-bold mt-1" dir="ltr">
            {fmtCurrencyFull(perf.thisMonth.gross)}
          </p>
          <p className="text-[11px] text-text-secondary mt-0.5">
            {perf.thisMonth.count}
          </p>
        </div>
        <div className="rounded-xl bg-bg-main/40 p-4">
          <p className="text-[11px] text-text-secondary uppercase tracking-wider">
            {t.paymentMix}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            <li className="flex justify-between">
              <span>{t.paymentMethods.cash}</span>
              <span dir="ltr">{fmtCurrencyShort(perf.paymentMix.cash)}</span>
            </li>
            <li className="flex justify-between">
              <span>{t.paymentMethods.card}</span>
              <span dir="ltr">{fmtCurrencyShort(perf.paymentMix.card)}</span>
            </li>
            <li className="flex justify-between">
              <span>{t.paymentMethods.instapay}</span>
              <span dir="ltr">{fmtCurrencyShort(perf.paymentMix.instapay)}</span>
            </li>
            <li className="flex justify-between">
              <span>{t.paymentMethods.deferred}</span>
              <span dir="ltr">{fmtCurrencyShort(perf.paymentMix.deferred)}</span>
            </li>
          </ul>
        </div>
      </div>

      <div>
        <p className="text-xs text-text-secondary uppercase tracking-wider mb-2">
          {t.chartTitle}
        </p>
        <SalesBarChart rows={perf.series12mo} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-text-secondary uppercase tracking-wider mb-1">
            {t.topBranches}
          </p>
          {perf.topBranches.length === 0 ? (
            <p className="text-xs text-text-secondary py-2">{t.noBranches}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {perf.topBranches.map((b) => (
                <li key={b.branchId} className="flex justify-between py-1.5">
                  <span className="font-medium" dir="auto">
                    {b.name}
                  </span>
                  <span className="text-text-secondary" dir="ltr">
                    {fmtCurrencyShort(b.gross)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs text-text-secondary uppercase tracking-wider mb-1">
            {t.topProducts}
          </p>
          {perf.topProducts.length === 0 ? (
            <p className="text-xs text-text-secondary py-2">{t.noProducts}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {perf.topProducts.map((p) => (
                <li key={p.productName} className="flex justify-between py-1.5">
                  <span className="font-medium truncate" dir="auto">
                    {p.productName}
                  </span>
                  <span className="text-text-secondary" dir="ltr">
                    {p.qty}× · {fmtCurrencyShort(p.gross)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function SalesBarChart({
  rows,
}: {
  rows: { month: string; gross: string; count: number }[];
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-text-secondary text-center py-6">—</p>;
  }
  const values = rows.map((r) => Number(r.gross));
  const max = Math.max(1, ...values);
  return (
    <div>
      <div className="flex items-end gap-[3px] h-24">
        {rows.map((r, i) => {
          const v = Number(r.gross);
          const h = Math.max(2, (v / max) * 100);
          return (
            <div
              key={r.month}
              title={`${r.month}: ₤${Number(r.gross).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${r.count})`}
              style={{ height: `${h}%` }}
              className={`flex-1 rounded-sm ${
                i === rows.length - 1 ? "bg-accent" : "bg-accent/40"
              }`}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-text-secondary mt-1.5" dir="ltr">
        <span>{rows[0]?.month}</span>
        <span>{rows[rows.length - 1]?.month}</span>
      </div>
    </div>
  );
}
