"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Toast } from "@/components/ui/Toast";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface Snapshot {
  cashFlow: {
    openingFloat: string;
    cashSales: string;
    cashRefunds: string;
    cashIn: string;
    cashOut: string;
    paidIn: string;
    paidOut: string;
    cashExpenses: string;
    expectedCash: string;
  };
  byMethod: Record<string, { count: number; total: string }>;
  counts: { sales: number; returns: number; expenses: number; movements: number };
  topProducts: { name: string; qty: number; revenue: string }[];
}

interface ShiftDetail {
  shift: {
    id: string;
    branchId: string;
    branchName: string | null;
    cashierName: string | null;
    status: "open" | "closed" | "reviewed";
    openedAt: string;
    openingFloat: string;
    closedAt: string | null;
    expectedCash: string | null;
    countedCash: string | null;
    variance: string | null;
    closingNote: string | null;
    closeReason: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
    totalsSnapshot: Snapshot | null;
  };
  cashFlow: Snapshot["cashFlow"] | null;
  snapshot: Snapshot | null;
}

interface Movement {
  id: string;
  kind: "cash_in" | "cash_out" | "paid_in" | "paid_out";
  amount: string;
  reason: string;
  recordedByName: string | null;
  recordedAt: string;
}

const fmt = (s: string | number | null | undefined) =>
  s == null
    ? "—"
    : Number(s).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export default function CashShiftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.cashShifts.detail;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [data, setData] = useState<ShiftDetail | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);
  const [showReviewConfirm, setShowReviewConfirm] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [showForceClose, setShowForceClose] = useState(false);
  const [forceReason, setForceReason] = useState("");

  const load = useCallback(async () => {
    try {
      const [shiftRes, movementsRes] = await Promise.all([
        fetch(`/api/cash-shifts/${id}`, { cache: "no-store" }),
        fetch(`/api/cash-shifts/${id}/movements`, { cache: "no-store" }),
      ]);
      if (shiftRes.ok) {
        const json: ShiftDetail = await shiftRes.json();
        setData(json);
      }
      if (movementsRes.ok) {
        const json: { data: Movement[] } = await movementsRes.json();
        setMovements(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const review = async () => {
    const res = await fetch(`/api/cash-shifts/${id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewNote: reviewNote.trim() || null }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setToast({ type: "error", message: j.error || t.review.errorGeneric });
      return;
    }
    setShowReviewConfirm(false);
    setReviewNote("");
    setToast({ type: "success", message: t.toast.reviewed });
    await load();
  };

  const forceClose = async () => {
    if (!forceReason.trim()) {
      setToast({ type: "error", message: t.force.reasonRequired });
      return;
    }
    const res = await fetch(`/api/cash-shifts/${id}/force-close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: forceReason.trim() }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setToast({ type: "error", message: j.error || t.force.errorGeneric });
      return;
    }
    setShowForceClose(false);
    setForceReason("");
    setToast({ type: "success", message: t.toast.closed });
    await load();
  };

  if (loading) {
    return (
      <AppShell title={t.titlePrefix}>
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell title={t.titlePrefix}>
        <p className="text-sm text-text-secondary text-center py-8">
          {t.notFound}
        </p>
      </AppShell>
    );
  }
  const { shift, cashFlow, snapshot } = data;
  const flow = cashFlow ?? snapshot?.cashFlow ?? null;
  const variance = shift.variance != null ? Number(shift.variance) : null;
  const tone =
    variance == null
      ? "neutral"
      : Math.abs(variance) < 1
        ? "good"
        : variance < 0
          ? "bad"
          : "warn";

  return (
    <AppShell title={`${t.titlePrefix} — ${shift.branchName ?? ""}`}>
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Header */}
        <header className="rounded-2xl border border-border bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-text-primary">
                {shift.cashierName ?? "—"} ·{" "}
                <span className="text-text-secondary text-sm">
                  {new Date(shift.openedAt).toLocaleString(dateLocale)}
                  {shift.closedAt
                    ? ` → ${new Date(shift.closedAt).toLocaleString(dateLocale)}`
                    : ""}
                </span>
              </h1>
              <div className="flex flex-wrap gap-2 mt-2">
                <Badge tone={statusTone(shift.status)}>
                  {statusLabel(shift.status, t)}
                </Badge>
                {shift.closeReason && shift.closeReason !== "cashier" && (
                  <Badge tone="warn">
                    {shift.closeReason === "forced"
                      ? t.status.forced
                      : t.status.autoClosed}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => window.print()}>
                {t.actions.print}
              </Button>
              {shift.status === "closed" && variance != null && Math.abs(variance) >= 1 && (
                <Button onClick={() => setShowReviewConfirm(true)}>
                  {t.actions.review}
                </Button>
              )}
              {shift.status === "open" && (
                <Button variant="danger" onClick={() => setShowForceClose(true)}>
                  {t.actions.forceClose}
                </Button>
              )}
            </div>
          </div>
        </header>

        {/* Variance hero (only after close) */}
        {shift.status !== "open" && (
          <div
            className={`rounded-2xl p-5 text-center ${
              tone === "good"
                ? "bg-success-light"
                : tone === "bad"
                  ? "bg-danger-light"
                  : tone === "warn"
                    ? "bg-orange-100"
                    : "bg-bg-main"
            }`}
          >
            <p className="text-xs text-text-secondary">
              {t.expectedCountedVariance}
            </p>
            <p className="text-2xl font-bold mt-1" dir="ltr">
              ₤{fmt(shift.expectedCash)} / ₤{fmt(shift.countedCash)} /{" "}
              <span
                className={
                  tone === "good"
                    ? "text-success"
                    : tone === "bad"
                      ? "text-danger"
                      : "text-orange-700"
                }
              >
                {variance != null && variance > 0 ? "+" : ""}₤{fmt(variance)}
              </span>
            </p>
            {shift.closingNote && (
              <p className="text-sm text-text-secondary mt-2">
                {shift.closingNote}
              </p>
            )}
          </div>
        )}

        {/* Cash flow ladder */}
        {flow && (
          <section className="rounded-2xl border border-border bg-white">
            <header className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">{t.sections.cashFlow}</h2>
            </header>
            <div className="divide-y divide-border">
              <Row label={t.lines.openingFloat} value={flow.openingFloat} sign="+" />
              <Row label={t.lines.cashSales} value={flow.cashSales} sign="+" />
              <Row label={t.lines.cashRefunds} value={flow.cashRefunds} sign="-" />
              <Row label={t.lines.paidIn} value={flow.paidIn} sign="+" />
              <Row label={t.lines.paidOut} value={flow.paidOut} sign="-" />
              <Row label={t.lines.cashIn} value={flow.cashIn} sign="+" />
              <Row label={t.lines.cashOut} value={flow.cashOut} sign="-" />
              <Row label={t.lines.cashExpenses} value={flow.cashExpenses} sign="-" />
              <Row
                label={t.lines.expectedCash}
                value={flow.expectedCash}
                sign="="
                emphasis
              />
            </div>
          </section>
        )}

        {/* By payment method */}
        {snapshot?.byMethod && (
          <section className="rounded-2xl border border-border bg-white">
            <header className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">{t.sections.byMethod}</h2>
            </header>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-4">
              {(["cash", "card", "instapay", "deferred"] as const).map((k) => (
                <div
                  key={k}
                  className="rounded-lg border border-border p-3 text-center"
                >
                  <p className="text-[11px] text-text-secondary">{t.method[k]}</p>
                  <p className="text-base font-bold mt-1" dir="ltr">
                    ₤{fmt(snapshot.byMethod[k]?.total)}
                  </p>
                  <p className="text-[10px] text-text-secondary">
                    {t.method.invoiceCount.replace(
                      "{count}",
                      String(snapshot.byMethod[k]?.count ?? 0),
                    )}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Top products */}
        {snapshot?.topProducts && snapshot.topProducts.length > 0 && (
          <section className="rounded-2xl border border-border bg-white">
            <header className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">{t.sections.topProducts}</h2>
            </header>
            <ol className="divide-y divide-border">
              {snapshot.topProducts.map((p, i) => (
                <li
                  key={p.name + i}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <span className="text-sm">{p.name}</span>
                  <span className="text-xs text-text-secondary" dir="ltr">
                    {p.qty}× · ₤{fmt(p.revenue)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Movements timeline */}
        {movements.length > 0 && (
          <section className="rounded-2xl border border-border bg-white">
            <header className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">{t.sections.movements}</h2>
            </header>
            <ul className="divide-y divide-border">
              {movements.map((m) => (
                <li key={m.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{t.movement[m.kind]}</span>
                    <span
                      dir="ltr"
                      className={
                        m.kind === "paid_in" || m.kind === "cash_in"
                          ? "text-success font-semibold"
                          : "text-danger font-semibold"
                      }
                    >
                      {m.kind === "paid_in" || m.kind === "cash_in" ? "+" : "-"}{" "}
                      ₤{fmt(m.amount)}
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5" dir="auto">
                    {m.reason} ·{" "}
                    {m.recordedByName ?? ""} ·{" "}
                    {new Date(m.recordedAt).toLocaleTimeString(dateLocale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Review note */}
        {shift.reviewedAt && (
          <section className="rounded-2xl bg-bg-main/40 border border-border p-4">
            <p className="text-xs text-text-secondary">{t.sections.reviewed}</p>
            <p className="text-sm mt-1">
              {new Date(shift.reviewedAt).toLocaleString(dateLocale)} ·{" "}
              {shift.reviewNote ?? ""}
            </p>
          </section>
        )}

        <Link
          href="/cash-shifts"
          className="block text-sm text-accent text-center"
        >
          {t.backToList}
        </Link>
      </div>

      {/* Review modal */}
      <Modal
        isOpen={showReviewConfirm}
        onClose={() => setShowReviewConfirm(false)}
        title={t.review.title}
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{t.review.intro}</p>
          <textarea
            rows={2}
            placeholder={t.review.notePlaceholder}
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border text-sm"
            dir="auto"
          />
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" onClick={() => setShowReviewConfirm(false)}>
              {dict.app.cashShifts.openModal.cancel}
            </Button>
            <Button onClick={review}>{t.review.confirm}</Button>
          </div>
        </div>
      </Modal>

      {/* Force-close modal */}
      <Modal
        isOpen={showForceClose}
        onClose={() => setShowForceClose(false)}
        title={t.force.title}
      >
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{t.force.intro}</p>
          <textarea
            rows={2}
            placeholder={t.force.reasonPlaceholder}
            value={forceReason}
            onChange={(e) => setForceReason(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border text-sm"
            dir="auto"
          />
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" onClick={() => setShowForceClose(false)}>
              {dict.app.cashShifts.openModal.cancel}
            </Button>
            <Button variant="danger" onClick={forceClose}>
              {t.force.confirm}
            </Button>
          </div>
        </div>
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

function Row({
  label,
  value,
  sign,
  emphasis,
}: {
  label: string;
  value: string;
  sign: "+" | "-" | "=";
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between px-5 py-3 text-sm ${
        emphasis ? "bg-bg-main/40 font-bold" : ""
      }`}
    >
      <span>{label}</span>
      <span dir="ltr">
        {sign === "=" ? "" : sign} ₤{fmt(value)}
      </span>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  const cls =
    tone === "good"
      ? "bg-success-light text-success"
      : tone === "bad"
        ? "bg-danger-light text-danger"
        : tone === "warn"
          ? "bg-orange-100 text-orange-700"
          : "bg-bg-main text-text-secondary";
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

function statusTone(s: "open" | "closed" | "reviewed"): string {
  if (s === "open") return "warn";
  if (s === "reviewed") return "good";
  return "neutral";
}

interface StatusT {
  status: { open: string; closed: string; reviewed: string };
}
function statusLabel(s: "open" | "closed" | "reviewed", t: StatusT): string {
  return s === "open" ? t.status.open : s === "closed" ? t.status.closed : t.status.reviewed;
}
