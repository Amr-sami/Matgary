// /insights/financials/money-movements — real CRUD (final slice).
//
// These movements are deliberately NEVER folded into P&L. The page makes
// that split visible: a Money-In vs Money-Out summary at the top, and a
// clear "not profit, not expense" note in the empty/explainer card.

"use client";

import { useMemo, useState } from "react";
import { Plus } from "@/lib/icons";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import {
  MONEY_MOVEMENT_KINDS,
  useMoneyMovements,
  type MoneyMovementKind,
  type MoneyMovementRow,
} from "@/hooks/useFinancials";

const PAYMENT_METHODS = ["cash", "instapay", "wallet", "card", "other"] as const;

export default function FinancialsMoneyMovementsPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;

  const [kindFilter, setKindFilter] = useState<string>("");
  const [status, setStatus] = useState<"active" | "voided" | "any">("active");

  const { data, loading, error, forbidden, refresh } = useMoneyMovements({
    kind: (kindFilter || undefined) as MoneyMovementKind | undefined,
    status,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<MoneyMovementRow | null>(null);

  async function handleVoid() {
    if (!voidTarget) return;
    try {
      const res = await fetch(
        `/api/financials/money-movements/${voidTarget.id}/void`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw new Error(`Void failed (${res.status})`);
      setVoidTarget(null);
      await refresh();
    } catch (err) {
      console.error("[finance] void movement failed:", err);
    }
  }

  const totals = useMemo(() => {
    const active = data?.data.filter((m) => !m.voidedAt) ?? [];
    return {
      moneyIn: active.filter((m) => m.direction === "in").reduce((s, m) => s + m.amount, 0),
      moneyOut: active.filter((m) => m.direction === "out").reduce((s, m) => s + m.amount, 0),
    };
  }, [data]);

  return (
    <div className="space-y-4">
      {/* Explainer strip — Money Movements are NOT P&L. */}
      <div className="rounded-xl border border-border bg-white p-4 text-sm text-text-secondary">
        {locale === "ar"
          ? "الحركات المالية مُنفصلة تمامًا عن الأرباح والخسائر. الإيداعات والسحوبات والقروض والتحويلات لا تظهر كإيرادات أو مصاريف."
          : "Money movements are kept separate from P&L. Deposits, withdrawals, loans, and transfers are not revenue or expenses."}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[200px]">
          <Select
            label={locale === "ar" ? "النوع" : "Kind"}
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            placeholder={locale === "ar" ? "جميع الأنواع" : "All kinds"}
            options={MONEY_MOVEMENT_KINDS.map((k) => ({
              value: k,
              label: kindLabel(k, locale),
            }))}
          />
        </div>
        <div className="w-[180px]">
          <Select
            label={locale === "ar" ? "الحالة" : "Status"}
            value={status}
            onChange={(e) => setStatus(e.target.value as "active" | "voided" | "any")}
            options={[
              { value: "active", label: locale === "ar" ? "نشط" : "Active" },
              { value: "voided", label: locale === "ar" ? "مُلغى" : "Voided" },
              { value: "any", label: locale === "ar" ? "الكل" : "All" },
            ]}
          />
        </div>
        <Button onClick={() => setCreateOpen(true)} className="ms-auto whitespace-nowrap">
          <Plus className="w-4 h-4 me-1" />
          {locale === "ar" ? "حركة جديدة" : "New movement"}
        </Button>
      </div>

      {/* Totals — honest split, no "net" because that would imply P&L. */}
      {data && data.data.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-white p-5">
            <div className="text-xs uppercase tracking-wider text-text-secondary font-semibold">
              {t.kpi.moneyIn}
            </div>
            <div className="mt-2 text-xl font-bold tabular-nums">
              {formatCurrency(totals.moneyIn, locale)}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-white p-5">
            <div className="text-xs uppercase tracking-wider text-text-secondary font-semibold">
              {t.kpi.moneyOut}
            </div>
            <div className="mt-2 text-xl font-bold tabular-nums">
              {formatCurrency(totals.moneyOut, locale)}
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {forbidden ? (
        <ForbiddenPanel />
      ) : loading && !data ? (
        <PageSkeleton rows={6} />
      ) : error && !data ? (
        <ErrorPanel message={error} onRetry={refresh} />
      ) : !data || data.data.length === 0 ? (
        <EmptyState type="sales" message={t.empty.hint} />
      ) : (
        <div className="rounded-xl border border-border bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-main text-text-secondary text-xs uppercase">
                <tr>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "التاريخ" : "Date"}
                  </th>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "النوع" : "Kind"}
                  </th>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "الوصف" : "Description"}
                  </th>
                  <th className="text-end px-4 py-3">
                    {locale === "ar" ? "اتجاه" : "Direction"}
                  </th>
                  <th className="text-end px-4 py-3">
                    {locale === "ar" ? "المبلغ" : "Amount"}
                  </th>
                  <th className="text-end px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.data.map((row) => (
                  <tr
                    key={row.id}
                    className={
                      "border-t border-border " +
                      (row.voidedAt ? "opacity-50" : "")
                    }
                  >
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                      {new Date(row.occurredAt).toLocaleDateString(
                        locale === "ar" ? "ar-EG" : "en-GB",
                        { year: "numeric", month: "short", day: "2-digit" },
                      )}
                    </td>
                    <td className="px-4 py-3">{kindLabel(row.kind, locale)}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {row.description || "—"}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Badge variant={row.direction === "in" ? "sold" : "other"}>
                        {row.direction === "in"
                          ? locale === "ar" ? "وارد" : "In"
                          : locale === "ar" ? "صادر" : "Out"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums font-medium">
                      {formatCurrency(row.amount, locale)}
                    </td>
                    <td className="px-4 py-3 text-end whitespace-nowrap">
                      {row.voidedAt ? (
                        <Badge variant="other">
                          {locale === "ar" ? "مُلغى" : "Voided"}
                        </Badge>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setVoidTarget(row)}
                          className="text-xs px-2 py-1 rounded border border-border hover:border-danger hover:text-danger"
                        >
                          {locale === "ar" ? "إلغاء" : "Void"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {createOpen && (
        <MovementFormModal
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await refresh();
          }}
        />
      )}

      {voidTarget && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => setVoidTarget(null)}
          onConfirm={handleVoid}
          title={locale === "ar" ? "إلغاء الحركة؟" : "Void movement?"}
          message={
            locale === "ar"
              ? "سيتم إلغاء الحركة وإظهارها كمُلغاة. السجل يُحفظ للمراجعة."
              : "The movement will be marked voided. The record is preserved for audit."
          }
          confirmText={locale === "ar" ? "إلغاء الحركة" : "Void movement"}
          variant="danger"
        />
      )}
    </div>
  );
}

function MovementFormModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const locale = useLocale();
  const [kind, setKind] = useState<MoneyMovementKind>("owner_deposit");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      setError(locale === "ar" ? "مبلغ غير صالح" : "Invalid amount");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/financials/money-movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          amount: amt,
          occurredAt: new Date(`${date}T12:00:00.000Z`).toISOString(),
          description: description.trim() || null,
          paymentMethod: paymentMethod || null,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "unknown" }));
        throw new Error(errBody.error ?? `failed (${res.status})`);
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={locale === "ar" ? "حركة مالية جديدة" : "New money movement"}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <Select
          label={locale === "ar" ? "النوع" : "Kind"}
          value={kind}
          onChange={(e) => setKind(e.target.value as MoneyMovementKind)}
          options={MONEY_MOVEMENT_KINDS.map((k) => ({
            value: k,
            label: kindLabel(k, locale),
          }))}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            type="number"
            min="0"
            step="0.01"
            label={locale === "ar" ? "المبلغ" : "Amount"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
          <Input
            type="date"
            label={locale === "ar" ? "التاريخ" : "Date"}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <Select
          label={locale === "ar" ? "طريقة الدفع" : "Payment method"}
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
          placeholder={locale === "ar" ? "لا شيء" : "None"}
          options={PAYMENT_METHODS.map((m) => ({ value: m, label: m }))}
        />
        <Input
          label={locale === "ar" ? "وصف" : "Description"}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {locale === "ar" ? "إلغاء" : "Cancel"}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting
              ? locale === "ar" ? "جار الحفظ..." : "Saving..."
              : locale === "ar" ? "إضافة" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function kindLabel(k: MoneyMovementKind, locale: string): string {
  const map: Record<string, { en: string; ar: string }> = {
    owner_deposit: { en: "Owner deposit", ar: "إيداع المالك" },
    owner_withdrawal: { en: "Owner withdrawal", ar: "سحب المالك" },
    cash_transfer: { en: "Cash transfer", ar: "تحويل نقدي" },
    loan_received: { en: "Loan received", ar: "قرض وارد" },
    loan_principal_repayment: { en: "Loan repayment", ar: "سداد قرض" },
    supplier_payment_direct: { en: "Supplier payment", ar: "دفعة مورد" },
    customer_deposit: { en: "Customer deposit", ar: "إيداع عميل" },
    other: { en: "Other", ar: "أخرى" },
  };
  const entry = map[k];
  if (!entry) return k;
  return locale === "ar" ? entry.ar : entry.en;
}

function ForbiddenPanel() {
  const locale = useLocale();
  const title = locale === "ar" ? "ليست لديك صلاحية الوصول" : "You don't have access";
  const hint =
    locale === "ar"
      ? "تحتاج صلاحية view_financials وmanage_money_movements."
      : "You need view_financials and manage_money_movements.";
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-secondary">{hint}</p>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const dict = useDictionary();
  const t = dict.app.financials.error;
  return (
    <div className="bg-white rounded-xl border border-danger-light p-8 text-center space-y-3">
      <h3 className="font-semibold text-danger">{t.title}</h3>
      <p className="text-sm text-text-secondary">{t.hint}</p>
      <p className="text-xs text-text-secondary font-mono">{message}</p>
      <Button onClick={onRetry}>{t.retry}</Button>
    </div>
  );
}
