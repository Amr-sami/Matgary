// /insights/financials/expenses — real CRUD (Slice 2b.1).
//
// Server is the single source of truth. All mutations go through the
// /api/financials/expenses{,[id],[id]/void} routes which enforce
// permissions (manage_expenses) + tenant isolation + audit.

"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "@/lib/icons";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCurrency } from "@/lib/i18n/format";
import {
  useDictionary,
  useLocale,
} from "@/components/i18n/DictionaryProvider";
import {
  useFinanceCategories,
  useFinanceExpenses,
  type FinanceCategoryNode,
  type FinanceExpenseListItem,
} from "@/hooks/useFinancials";

const PAYMENT_METHODS = ["cash", "instapay", "wallet", "card", "other"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export default function FinancialsExpensesPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;
  const isRtl = locale === "ar";

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"posted" | "voided" | "any">("posted");
  const [categoryId, setCategoryId] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<string>("");

  const { data, loading, error, forbidden, refresh } = useFinanceExpenses({
    status,
    categoryId: categoryId || undefined,
    paymentMethod: paymentMethod || undefined,
    search: search.trim() || undefined,
  });
  const { tree, loading: catLoading } = useFinanceCategories();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceExpenseListItem | null>(null);
  const [voidTarget, setVoidTarget] = useState<FinanceExpenseListItem | null>(null);
  // ConfirmDialog in Slice 2b.1 doesn't support a free-text input slot, so
  // void reason is not captured from the UI yet. The API still accepts
  // `reason`; a dedicated reason prompt lands in Slice 2b.2 with the
  // money-movement reversal UX.

  async function handleVoid() {
    if (!voidTarget) return;
    try {
      const res = await fetch(
        `/api/financials/expenses/${voidTarget.id}/void`,
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
      console.error("[finance] void expense failed:", err);
    }
  }

  // Flat category list for the filter dropdown (groups + leaves).
  const categoryOptions = useMemo(
    () => (tree ? flattenCategories(tree, isRtl) : []),
    [tree, isRtl],
  );

  return (
    <div className="space-y-4">
      {/* Toolbar: filters + create */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <Input
            label={locale === "ar" ? "بحث" : "Search"}
            placeholder={
              locale === "ar"
                ? "العنوان، المرجع، الملاحظة"
                : "Title, reference, note"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-[180px]">
          <Select
            label={locale === "ar" ? "الحالة" : "Status"}
            value={status}
            onChange={(e) => setStatus(e.target.value as "posted" | "voided" | "any")}
            options={[
              { value: "posted", label: locale === "ar" ? "مُعتمد" : "Posted" },
              { value: "voided", label: locale === "ar" ? "مُلغى" : "Voided" },
              { value: "any", label: locale === "ar" ? "الكل" : "All" },
            ]}
          />
        </div>
        <div className="w-[220px]">
          <Select
            label={locale === "ar" ? "الفئة" : "Category"}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            placeholder={locale === "ar" ? "كل الفئات" : "All categories"}
            options={categoryOptions}
          />
        </div>
        <div className="w-[160px]">
          <Select
            label={locale === "ar" ? "طريقة الدفع" : "Payment method"}
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            placeholder={locale === "ar" ? "أي طريقة" : "Any method"}
            options={PAYMENT_METHODS.map((m) => ({
              value: m,
              label: paymentLabel(m, locale),
            }))}
          />
        </div>
        <Button onClick={() => setCreateOpen(true)} className="whitespace-nowrap">
          <Plus className="w-4 h-4 me-1" />
          {locale === "ar" ? "مصروف جديد" : "New expense"}
        </Button>
      </div>

      {/* List */}
      {forbidden ? (
        <ForbiddenPanel />
      ) : loading && !data ? (
        <PageSkeleton rows={8} />
      ) : error && !data ? (
        <ErrorPanel message={error} onRetry={refresh} />
      ) : !data || data.data.length === 0 ? (
        <EmptyState type="sales" message={t.empty.hint} />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-main text-text-secondary text-xs uppercase">
                <tr>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "التاريخ" : "Date"}
                  </th>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "العنوان" : "Title"}
                  </th>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "الفئة" : "Category"}
                  </th>
                  <th className="text-start px-4 py-3">
                    {locale === "ar" ? "طريقة الدفع" : "Payment"}
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
                      (row.status === "voided" ? "opacity-50" : "")
                    }
                  >
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                      {new Date(row.date).toLocaleDateString(
                        locale === "ar" ? "ar-EG" : "en-GB",
                        { year: "numeric", month: "short", day: "2-digit" },
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">
                        {row.title}
                      </div>
                      {row.referenceNumber && (
                        <div className="text-xs text-text-secondary">
                          #{row.referenceNumber}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isRtl
                        ? row.categoryNameAr ?? "—"
                        : row.categoryNameEn ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {row.paymentMethod
                        ? paymentLabel(row.paymentMethod, locale)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums font-medium">
                      {formatCurrency(row.amount, locale)}
                    </td>
                    <td className="px-4 py-3 text-end whitespace-nowrap">
                      {row.status === "voided" ? (
                        <Badge variant="other">
                          {locale === "ar" ? "مُلغى" : "Voided"}
                        </Badge>
                      ) : (
                        <div className="inline-flex gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(row)}
                            className="text-xs px-2 py-1 rounded border border-border hover:border-accent"
                          >
                            {locale === "ar" ? "تعديل" : "Edit"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setVoidTarget(row)}
                            className="text-xs px-2 py-1 rounded border border-border hover:border-danger hover:text-danger"
                          >
                            {locale === "ar" ? "إلغاء" : "Void"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create modal */}
      {createOpen && (
        <ExpenseFormModal
          mode="create"
          categories={tree ?? []}
          catsLoading={catLoading}
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await refresh();
          }}
        />
      )}

      {/* Edit modal */}
      {editing && (
        <ExpenseFormModal
          mode="edit"
          categories={tree ?? []}
          catsLoading={catLoading}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}

      {/* Void confirm */}
      {voidTarget && (
        <ConfirmDialog
          isOpen={true}
          onClose={() => setVoidTarget(null)}
          onConfirm={handleVoid}
          title={locale === "ar" ? "إلغاء المصروف؟" : "Void expense?"}
          message={
            locale === "ar"
              ? `سيتم إخفاء "${voidTarget.title}" من الأرباح والخسائر. لن يُحذف من قاعدة البيانات.`
              : `"${voidTarget.title}" will be excluded from the P&L. The record is preserved for audit.`
          }
          confirmText={locale === "ar" ? "إلغاء المصروف" : "Void expense"}
          variant="danger"
        />
      )}
    </div>
  );
}

// ─── Expense form (create + edit) ──────────────────────────────────────────

function ExpenseFormModal({
  mode,
  categories,
  catsLoading,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  categories: FinanceCategoryNode[];
  catsLoading: boolean;
  initial?: FinanceExpenseListItem;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const dict = useDictionary();
  const locale = useLocale();
  const isRtl = locale === "ar";

  const [title, setTitle] = useState(initial?.title ?? "");
  const [amount, setAmount] = useState<string>(
    initial ? String(initial.amount) : "",
  );
  const [date, setDate] = useState(
    initial
      ? initial.date.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  );
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "");
  const [paymentMethod, setPaymentMethod] = useState<string>(
    initial?.paymentMethod ?? "",
  );
  const [referenceNumber, setReferenceNumber] = useState(
    initial?.referenceNumber ?? "",
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categoryOptions = useMemo(
    () => flattenCategories(categories, isRtl, { leavesOnly: true }),
    [categories, isRtl],
  );

  async function submit() {
    setError(null);
    const amt = Number(amount);
    if (!title.trim()) {
      setError(locale === "ar" ? "العنوان مطلوب" : "Title is required");
      return;
    }
    if (!Number.isFinite(amt) || amt < 0) {
      setError(locale === "ar" ? "مبلغ غير صالح" : "Invalid amount");
      return;
    }
    if (!categoryId) {
      setError(locale === "ar" ? "اختر الفئة" : "Pick a category");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        title: title.trim(),
        amount: amt,
        date: new Date(`${date}T12:00:00.000Z`).toISOString(),
        categoryId,
        paymentMethod: paymentMethod || null,
        referenceNumber: referenceNumber.trim() || null,
        note: note.trim() || null,
      };
      const res =
        mode === "create"
          ? await fetch("/api/financials/expenses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
          : await fetch(`/api/financials/expenses/${initial!.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
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
      title={
        mode === "create"
          ? locale === "ar"
            ? "مصروف جديد"
            : "New expense"
          : locale === "ar"
            ? "تعديل المصروف"
            : "Edit expense"
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <Input
          label={locale === "ar" ? "العنوان" : "Title"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
          label={locale === "ar" ? "الفئة" : "Category"}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          placeholder={
            catsLoading
              ? locale === "ar"
                ? "جار التحميل..."
                : "Loading..."
              : locale === "ar"
                ? "اختر الفئة"
                : "Pick a category"
          }
          options={categoryOptions}
          disabled={catsLoading}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label={locale === "ar" ? "طريقة الدفع" : "Payment method"}
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            placeholder={locale === "ar" ? "لا شيء" : "None"}
            options={PAYMENT_METHODS.map((m) => ({
              value: m,
              label: paymentLabel(m, locale),
            }))}
          />
          <Input
            label={locale === "ar" ? "رقم المرجع" : "Reference #"}
            value={referenceNumber}
            onChange={(e) => setReferenceNumber(e.target.value)}
          />
        </div>
        <Input
          label={locale === "ar" ? "ملاحظات" : "Notes"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && (
          <p className="text-sm text-danger">{error}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {locale === "ar" ? "إلغاء" : "Cancel"}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting
              ? locale === "ar"
                ? "جار الحفظ..."
                : "Saving..."
              : mode === "create"
                ? locale === "ar"
                  ? "إضافة"
                  : "Create"
                : locale === "ar"
                  ? "حفظ"
                  : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function flattenCategories(
  nodes: FinanceCategoryNode[],
  isRtl: boolean,
  opts: { leavesOnly?: boolean } = {},
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (list: FinanceCategoryNode[], parentLabel = "") => {
    for (const node of list) {
      if (node.archivedAt) continue;
      const label = isRtl ? node.nameAr : node.nameEn;
      const fullLabel = parentLabel ? `${parentLabel} › ${label}` : label;
      if (!opts.leavesOnly || node.children.length === 0) {
        out.push({ value: node.id, label: fullLabel });
      }
      if (node.children.length > 0) walk(node.children, fullLabel);
    }
  };
  walk(nodes);
  return out;
}

function paymentLabel(m: string, locale: string): string {
  if (locale === "ar") {
    return (
      {
        cash: "نقدي",
        instapay: "إنستا باي",
        wallet: "محفظة",
        card: "بطاقة",
        other: "أخرى",
      } as Record<string, string>
    )[m] ?? m;
  }
  return (
    {
      cash: "Cash",
      instapay: "InstaPay",
      wallet: "Wallet",
      card: "Card",
      other: "Other",
    } as Record<string, string>
  )[m] ?? m;
}

function ForbiddenPanel() {
  const locale = useLocale();
  const title = locale === "ar" ? "ليست لديك صلاحية الوصول" : "You don't have access";
  const hint =
    locale === "ar"
      ? "تحتاج صلاحية view_financials وmanage_expenses."
      : "You need view_financials and manage_expenses.";
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

// `X` imported for the Modal's own close button rendering; not used directly.
void X;
