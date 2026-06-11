"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { X, Plus, ChevronRight } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { useCashShift } from "@/hooks/useCashShift";
import { MovementForm } from "./MovementForm";
import { CloseShiftModal } from "./CloseShiftModal";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";

interface CashFlowResp {
  shift: {
    id: string;
    branchName: string | null;
    cashierName: string | null;
    openedAt: string;
    openingFloat: string;
  };
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
    byMethod: Record<string, { count: number; total: string }>;
    counts: { sales: number; returns: number; expenses: number; movements: number };
  } | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onClosed: () => Promise<void>;
  onError: (msg: string) => void;
}

const fmt = (s: string | null | undefined) =>
  s == null
    ? "—"
    : Number(s).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export function CashDrawerPanel({
  isOpen,
  onClose,
  onClosed,
  onError,
}: Props) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.cashShifts.panel;
  const detailLines = dict.app.cashShifts.detail.lines;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const { shift, refresh } = useCashShift();
  const [detail, setDetail] = useState<CashFlowResp | null>(null);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showMovementForm, setShowMovementForm] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!shift) return;
    const res = await fetch(`/api/cash-shifts/${shift.id}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const json: CashFlowResp = await res.json();
    setDetail(json);
  }, [shift]);

  useEffect(() => {
    if (!isOpen) return;
    loadDetail();
    const intervalId = setInterval(loadDetail, 15_000);
    return () => clearInterval(intervalId);
  }, [isOpen, loadDetail]);

  if (!isOpen || !shift) return null;
  const cf = detail?.cashFlow;
  const openedTime = new Date(shift.openedAt).toLocaleTimeString(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dir = locale === "ar" ? "rtl" : "ltr";

  return (
    <>
      {/* Backdrop */}
      <button
        aria-label={t.closeButton}
        onClick={onClose}
        className="fixed inset-0 bg-black/40 z-40"
      />
      {/* Slide-over */}
      <aside
        className="fixed end-0 top-0 bottom-0 z-50 w-full max-w-md bg-white shadow-2xl flex flex-col"
        dir={dir}
      >
        <header className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-text-primary">
              {t.title.replace("{branch}", shift.branchName ?? "")}
            </h2>
            <p className="text-xs text-text-secondary mt-0.5">
              {t.subtitle
                .replace("{cashier}", shift.cashierName ?? "")
                .replace("{time}", openedTime)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-bg-main text-text-secondary"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Expected cash hero */}
          <div className="rounded-2xl bg-accent-light p-5 text-center">
            <p className="text-xs text-text-secondary">{t.expectedCash}</p>
            <p className="text-3xl font-bold text-accent mt-1" dir="ltr">
              ₤{fmt(cf?.expectedCash)}
            </p>
            <p className="text-[11px] text-text-secondary mt-1">
              {t.countsLine
                .replace("{sales}", String(cf?.counts.sales ?? 0))
                .replace("{movements}", String(cf?.counts.movements ?? 0))
                .replace("{expenses}", String(cf?.counts.expenses ?? 0))}
            </p>
          </div>

          {/* Cash flow ladder */}
          {cf && (
            <div className="rounded-xl border border-border divide-y divide-border">
              <Row label={detailLines.openingFloat} value={cf.openingFloat} sign="+" />
              <Row label={detailLines.cashSales} value={cf.cashSales} sign="+" />
              <Row label={detailLines.cashRefunds} value={cf.cashRefunds} sign="-" />
              <Row label={detailLines.paidIn} value={cf.paidIn} sign="+" />
              <Row label={detailLines.paidOut} value={cf.paidOut} sign="-" />
              <Row label={detailLines.cashIn} value={cf.cashIn} sign="+" />
              <Row label={detailLines.cashOut} value={cf.cashOut} sign="-" />
              <Row label={detailLines.cashExpenses} value={cf.cashExpenses} sign="-" />
            </div>
          )}

          {/* Movement quick-add */}
          {!showMovementForm ? (
            <button
              type="button"
              onClick={() => setShowMovementForm(true)}
              className="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-lg border border-dashed border-border text-sm text-text-secondary hover:border-accent hover:text-accent"
            >
              <Plus className="w-4 h-4" />
              {t.addMovement}
            </button>
          ) : (
            <MovementForm
              shiftId={shift.id}
              onSaved={async () => {
                await loadDetail();
                setShowMovementForm(false);
              }}
              onCancel={() => setShowMovementForm(false)}
              onError={onError}
            />
          )}

          <Link
            href={`/cash-shifts/${shift.id}`}
            className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm text-text-secondary hover:bg-bg-main"
          >
            <span>{t.viewDetails}</span>
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>

        <footer className="px-5 py-4 border-t border-border bg-bg-main/30">
          <Button
            onClick={() => setShowCloseModal(true)}
            className="w-full"
            variant="primary"
          >
            {t.closeButton}
          </Button>
        </footer>
      </aside>

      <CloseShiftModal
        isOpen={showCloseModal}
        shiftId={shift.id}
        expectedCash={cf?.expectedCash ?? "0"}
        onClose={() => setShowCloseModal(false)}
        onClosed={async () => {
          await refresh();
          await onClosed();
        }}
        onError={onError}
      />
    </>
  );
}

function Row({
  label,
  value,
  sign,
}: {
  label: string;
  value: string;
  sign: "+" | "-";
}) {
  const n = Number(value);
  const dimmed = n === 0;
  return (
    <div
      className={`flex items-center justify-between px-3 py-2.5 text-sm ${
        dimmed ? "text-text-secondary" : "text-text-primary"
      }`}
    >
      <span>{label}</span>
      <span dir="ltr" className={dimmed ? "" : "font-semibold"}>
        {sign} ₤{fmt(value)}
      </span>
    </div>
  );
}
