"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { CheckCircle, AlertCircle, Receipt, Clock } from "@/lib/icons";
import type { PlanKey } from "@/lib/payments/plans";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface PublicPlan {
  key: PlanKey;
  labelAr: string;
  labelEn: string;
  taglineAr: string;
  taglineEn: string;
  monthlyEgp: number;
  purchasable: boolean;
  featuresAr: string[];
  featuresEn: string[];
  sortOrder: number;
}

interface SubscriptionData {
  plan: PlanKey;
  status: string;
  trialEndsAt: string;
  currentPeriodEndsAt: string | null;
  cancelledAt: string | null;
  amountEgp: number | null;
  isAccessActive: boolean;
  daysLeftInTrial: number | null;
  paymobConfigured: boolean;
  history: Array<{
    id: string;
    paymobOrderId: string | null;
    amountEgp: string;
    status: string;
    failureReason: string | null;
    attemptedAt: string;
    settledAt: string | null;
  }>;
}

export default function BillingPage() {
  const { data: session, status: authStatus } = useSession();
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.billing;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const isOwner = session?.user?.role === "owner";
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [meRes, plansRes] = await Promise.all([
        fetch("/api/billing/me", { cache: "no-store" }),
        // Public + cached; falls back to typed defaults if DB hiccups.
        fetch("/api/plans", { cache: "no-store" }),
      ]);
      if (meRes.ok) {
        const json = (await meRes.json()) as SubscriptionData;
        setData(json);
      }
      if (plansRes.ok) {
        const json = (await plansRes.json()) as { data: PublicPlan[] };
        setPlans(json.data);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authStatus === "authenticated") refresh();
  }, [authStatus]);

  const subscribe = async (plan: PlanKey) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || t.errors.cantOpenCheckout);
        return;
      }
      // Redirect into Paymob iframe on the same tab — Paymob bounces back
      // to a configured success/failure URL, then our webhook completes.
      window.location.href = json.iframeUrl;
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm(t.cancelConfirm)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/billing/cancel", { method: "POST" });
      if (res.ok) await refresh();
      else {
        const json = await res.json();
        setError(json.error || t.errors.cantCancel);
      }
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (s: string) =>
    (t.status as Record<string, string>)[s] ?? s;

  // Plan content (label / tagline / feature bullets / price / purchasable)
  // comes from /api/plans (Spec 04), which reads platform_plans live.
  // Admin edits at /admin/plans reflect here within ~1 minute. When the
  // tenant locale is Arabic we render labelAr/etc.; English picks the *_en
  // siblings.
  const planContent = (k: PlanKey): { label: string; tagline: string; features: string[] } | null => {
    const p = plans.find((pp) => pp.key === k);
    if (!p) return null;
    return locale === "ar"
      ? { label: p.labelAr, tagline: p.taglineAr, features: p.featuresAr }
      : { label: p.labelEn, tagline: p.taglineEn, features: p.featuresEn };
  };

  return (
    <AppShell title={t.title}>
      <div className="max-w-4xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
        </header>

        {!isOwner && (
          <div className="bg-bg-card border border-border rounded-xl p-6 text-center text-text-secondary">
            {t.ownerOnly}
          </div>
        )}

        {isOwner && loading && (
          <p className="text-sm text-text-secondary">{t.loading}</p>
        )}

        {isOwner && data && (
          <>
            {/* Current state card */}
            <div className="bg-bg-card border border-border rounded-2xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                {data.isAccessActive ? (
                  <CheckCircle className="w-5 h-5 text-success" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-danger" />
                )}
                <span className="font-semibold text-text-primary">
                  {statusLabel(data.status)}
                </span>
                <span className="text-text-secondary text-sm">
                  • {planContent(data.plan)?.label ?? data.plan}
                </span>
              </div>
              {data.status === "trialing" && (
                <p className="text-sm text-text-secondary">
                  {t.statusLine.trialDaysLeft.replace(
                    "{days}",
                    String(data.daysLeftInTrial ?? 0),
                  )}
                </p>
              )}
              {data.status === "active" && data.currentPeriodEndsAt && (
                <p className="text-sm text-text-secondary">
                  {t.statusLine.renewalOn.replace(
                    "{date}",
                    new Date(data.currentPeriodEndsAt).toLocaleDateString(
                      dateLocale,
                    ),
                  )}
                </p>
              )}
              {data.status === "past_due" && (
                <p className="text-sm text-danger">
                  {t.statusLine.pastDueWarning}
                </p>
              )}
              {data.status === "cancelled" && data.currentPeriodEndsAt && (
                <p className="text-sm text-text-secondary">
                  {t.statusLine.cancelledUntil.replace(
                    "{date}",
                    new Date(data.currentPeriodEndsAt).toLocaleDateString(
                      dateLocale,
                    ),
                  )}
                </p>
              )}
              {!data.paymobConfigured && (
                <p className="text-xs text-text-secondary border-t border-border pt-3">
                  {t.statusLine.paymobNotConfigured}
                </p>
              )}
            </div>

            {/* Plan picker */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {plans
                .filter((p) => p.purchasable || p.key === "multi_branch")
                .map((plan) => {
                  const k = plan.key;
                  const content = planContent(k);
                  if (!content) return null;
                  const isCurrent = data.plan === k && data.status === "active";
                  return (
                    <div
                      key={k}
                      className="bg-bg-card border border-border rounded-2xl p-5 flex flex-col"
                    >
                      <div className="mb-3">
                        <h3 className="text-lg font-bold text-text-primary">
                          {content.label}
                        </h3>
                        <p className="text-xs text-text-secondary mt-0.5">
                          {content.tagline}
                        </p>
                      </div>
                      <div className="mb-4">
                        {plan.purchasable ? (
                          <p className="text-3xl font-extrabold text-accent">
                            {plan.monthlyEgp}{" "}
                            <span className="text-sm font-normal text-text-secondary">
                              {t.perMonth}
                            </span>
                          </p>
                        ) : (
                          <p className="text-sm text-text-secondary">
                            {k === "multi_branch" ? t.comingSoon : t.dash}
                          </p>
                        )}
                      </div>
                      <ul className="space-y-1.5 mb-4 flex-1">
                        {content.features.map((f: string) => (
                          <li
                            key={f}
                            className="text-sm text-text-secondary flex items-start gap-2"
                          >
                            <CheckCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                      {plan.purchasable && (
                        <Button
                          onClick={() => subscribe(k)}
                          disabled={isCurrent || busy || !data.paymobConfigured}
                          loading={busy}
                          className="w-full"
                        >
                          {isCurrent
                            ? t.actions.currentPlan
                            : t.actions.subscribeNow}
                        </Button>
                      )}
                    </div>
                  );
                })}
            </div>

            {error && (
              <div className="bg-danger-light text-danger rounded-lg p-3 text-sm">
                {error}
              </div>
            )}

            {/* Cancel */}
            {data.status === "active" && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                  className="text-sm text-text-secondary hover:text-danger"
                >
                  {t.actions.cancelSubscription}
                </button>
              </div>
            )}

            {/* History */}
            <div className="bg-bg-card border border-border rounded-2xl">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                <Receipt className="w-4 h-4 text-text-secondary" />
                <h3 className="text-sm font-semibold text-text-primary">
                  {t.history.title}
                </h3>
              </div>
              {data.history.length === 0 ? (
                <p className="text-sm text-text-secondary text-center py-8">
                  {t.history.empty}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.history.map((h) => {
                    const attemptLabel =
                      (t.attemptStatus as Record<string, string>)[h.status] ??
                      h.status;
                    const tone =
                      h.status === "succeeded"
                        ? "bg-success-light text-success"
                        : h.status === "failed"
                          ? "bg-danger-light text-danger"
                          : h.status === "pending"
                            ? "bg-orange-100 text-orange-700"
                            : "bg-bg-main text-text-secondary";
                    return (
                      <li key={h.id} className="px-5 py-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${tone}`}
                            >
                              {attemptLabel}
                            </span>
                            <span className="font-medium text-text-primary">
                              {h.amountEgp} {locale === "ar" ? "ج" : "EGP"}
                            </span>
                          </div>
                          <p className="text-xs text-text-secondary mt-0.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(h.attemptedAt).toLocaleString(dateLocale)}
                          </p>
                          {h.failureReason && (
                            <p className="text-xs text-danger mt-1">
                              {h.failureReason}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
