"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { CheckCircle, AlertCircle, Receipt, Clock } from "@/lib/icons";
import { PLANS, type PlanKey } from "@/lib/payments/plans";

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

const STATUS_LABEL: Record<string, string> = {
  trialing: "تجربة مجانية",
  active: "اشتراك مفعّل",
  past_due: "تأخر السداد",
  cancelled: "تم الإلغاء",
  expired: "منتهي",
};

const ATTEMPT_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "بانتظار التأكيد", tone: "bg-orange-100 text-orange-700" },
  succeeded: { label: "تم الدفع", tone: "bg-success-light text-success" },
  failed: { label: "فشل الدفع", tone: "bg-danger-light text-danger" },
};

export default function BillingPage() {
  const { data: session, status: authStatus } = useSession();
  const isOwner = session?.user?.role === "owner";
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/me", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as SubscriptionData;
        setData(json);
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
        setError(json.error || "تعذر فتح صفحة الدفع");
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
    if (!window.confirm("هل أنت متأكد من إلغاء الاشتراك؟ ستظل الخدمة مفعّلة حتى نهاية الفترة المدفوعة.")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/billing/cancel", { method: "POST" });
      if (res.ok) await refresh();
      else {
        const json = await res.json();
        setError(json.error || "تعذر إلغاء الاشتراك");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="الاشتراك">
      <div className="max-w-4xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">الاشتراك</h1>
          <p className="text-sm text-text-secondary mt-1">
            إدارة باقتك، الدفع، وسجل الفواتير.
          </p>
        </header>

        {!isOwner && (
          <div className="bg-bg-card border border-border rounded-xl p-6 text-center text-text-secondary">
            هذه الصفحة مخصَّصة لصاحب المتجر فقط.
          </div>
        )}

        {isOwner && loading && (
          <p className="text-sm text-text-secondary">جاري التحميل…</p>
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
                  {STATUS_LABEL[data.status] ?? data.status}
                </span>
                <span className="text-text-secondary text-sm">
                  • {PLANS[data.plan]?.label ?? data.plan}
                </span>
              </div>
              {data.status === "trialing" && (
                <p className="text-sm text-text-secondary">
                  متبقي{" "}
                  <span className="font-bold text-text-primary">
                    {data.daysLeftInTrial ?? 0}
                  </span>{" "}
                  يوم في التجربة المجانية.
                </p>
              )}
              {data.status === "active" && data.currentPeriodEndsAt && (
                <p className="text-sm text-text-secondary">
                  التجديد القادم في{" "}
                  {new Date(data.currentPeriodEndsAt).toLocaleDateString("ar-EG")}.
                </p>
              )}
              {data.status === "past_due" && (
                <p className="text-sm text-danger">
                  الدفعة الأخيرة فشلت. أعِد المحاولة لتجنب إيقاف الخدمة.
                </p>
              )}
              {data.status === "cancelled" && data.currentPeriodEndsAt && (
                <p className="text-sm text-text-secondary">
                  الخدمة مفعّلة حتى{" "}
                  {new Date(data.currentPeriodEndsAt).toLocaleDateString("ar-EG")}.
                </p>
              )}
              {!data.paymobConfigured && (
                <p className="text-xs text-text-secondary border-t border-border pt-3">
                  بوابة الدفع غير مهيأة على هذا الخادم بعد. تواصل معنا للترقية يدوياً
                  حتى نُكمل التهيئة.
                </p>
              )}
            </div>

            {/* Plan picker */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(Object.keys(PLANS) as PlanKey[])
                .filter((k) => PLANS[k].purchasable || k === "multi_branch")
                .map((k) => {
                  const plan = PLANS[k];
                  const isCurrent = data.plan === k && data.status === "active";
                  return (
                    <div
                      key={k}
                      className="bg-bg-card border border-border rounded-2xl p-5 flex flex-col"
                    >
                      <div className="mb-3">
                        <h3 className="text-lg font-bold text-text-primary">
                          {plan.label}
                        </h3>
                        <p className="text-xs text-text-secondary mt-0.5">
                          {plan.tagline}
                        </p>
                      </div>
                      <div className="mb-4">
                        {plan.purchasable ? (
                          <p className="text-3xl font-extrabold text-accent">
                            {plan.monthlyEgp}{" "}
                            <span className="text-sm font-normal text-text-secondary">
                              ج / شهر
                            </span>
                          </p>
                        ) : (
                          <p className="text-sm text-text-secondary">
                            {k === "multi_branch" ? "قريباً" : "—"}
                          </p>
                        )}
                      </div>
                      <ul className="space-y-1.5 mb-4 flex-1">
                        {plan.features.map((f) => (
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
                          {isCurrent ? "باقتك الحالية" : "اشترك الآن"}
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
                  إلغاء الاشتراك
                </button>
              </div>
            )}

            {/* History */}
            <div className="bg-bg-card border border-border rounded-2xl">
              <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                <Receipt className="w-4 h-4 text-text-secondary" />
                <h3 className="text-sm font-semibold text-text-primary">سجل الدفع</h3>
              </div>
              {data.history.length === 0 ? (
                <p className="text-sm text-text-secondary text-center py-8">
                  لا توجد محاولات دفع بعد.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.history.map((h) => {
                    const tone =
                      ATTEMPT_STATUS[h.status] ??
                      { label: h.status, tone: "bg-bg-main text-text-secondary" };
                    return (
                      <li key={h.id} className="px-5 py-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs px-2 py-0.5 rounded-full ${tone.tone}`}
                            >
                              {tone.label}
                            </span>
                            <span className="font-medium text-text-primary">
                              {h.amountEgp} ج
                            </span>
                          </div>
                          <p className="text-xs text-text-secondary mt-0.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {new Date(h.attemptedAt).toLocaleString("ar-EG")}
                          </p>
                          {h.failureReason && (
                            <p className="text-xs text-danger mt-1">{h.failureReason}</p>
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
