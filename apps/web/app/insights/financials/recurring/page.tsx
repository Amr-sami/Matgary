// /insights/financials/recurring — recurring expense templates + manual
// generator trigger. A template is an `expenses` row with isRecurring=true
// + recurrencePeriod + nextOccurrenceDate; children are regular expenses
// with parent_expense_id pointing back. The DB-level UNIQUE on
// (tenant_id, parent_expense_id, date) is the idempotency guard.

"use client";

import { useEffect, useState } from "react";
import { Plus, RotateCcw } from "@/lib/icons";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCurrency } from "@/lib/i18n/format";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { useFinanceCategories } from "@/hooks/useFinancials";

interface RecurringTemplate {
  id: string;
  title: string;
  amount: number;
  categoryId: string | null;
  categoryLabel: string | null;
  recurrencePeriod: "monthly" | "weekly" | null;
  nextOccurrenceDate: string | null;
  isActive: boolean;
}

export default function FinancialsRecurringPage() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.financials;

  const [templates, setTemplates] = useState<RecurringTemplate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastSpawn, setLastSpawn] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { tree } = useFinanceCategories();

  const refresh = async () => {
    setError(null);
    try {
      // Templates are isRecurring=true in expenses. Fetch via the standard
      // Financials expense list — the row set is tiny (template count per
      // tenant) so paging isn't needed.
      const res = await fetch(
        "/api/financials/expenses?status=any&limit=200",
        { cache: "no-store" },
      );
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const json = (await res.json()) as {
        data: {
          id: string;
          title: string;
          amount: number;
          categoryId: string | null;
          categoryNameEn: string | null;
          categoryNameAr: string | null;
          isRecurringTemplate: boolean;
          status: string;
        }[];
      };
      // Only show templates. Children carry parent_expense_id and show up
      // in the regular Expenses page.
      const onlyTemplates = json.data.filter((r) => r.isRecurringTemplate);
      setTemplates(
        onlyTemplates.map((r) => ({
          id: r.id,
          title: r.title,
          amount: r.amount,
          categoryId: r.categoryId,
          categoryLabel:
            (locale === "ar" ? r.categoryNameAr : r.categoryNameEn) ?? null,
          // We don't get the period/nextOccurrence back from this endpoint.
          // Future endpoint `/api/financials/recurring` can expose them;
          // for now show an honest placeholder.
          recurrencePeriod: null,
          nextOccurrenceDate: null,
          isActive: r.status !== "voided",
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const res = await fetch("/api/financials/recurring/generate", {
        method: "POST",
      });
      if (!res.ok) {
        if (res.status === 403) {
          setError(locale === "ar" ? "لا تملك الصلاحية" : "Permission denied");
          return;
        }
        throw new Error(`failed (${res.status})`);
      }
      const json = (await res.json()) as { spawned: number };
      setLastSpawn(json.spawned);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-white p-4 text-sm text-text-secondary">
        {locale === "ar"
          ? "القوالب الدورية تُولِّد مصاريف حقيقية في موعدها. إعادة التشغيل لن يُنشئ تكرارات — القاعدة محمية بفهرس فريد في قاعدة البيانات."
          : "Recurring templates generate real expense rows on schedule. Re-running is safe — the database enforces no duplicates via a partial UNIQUE index."}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          {lastSpawn !== null && (
            <Badge variant={lastSpawn > 0 ? "sold" : "other"}>
              {locale === "ar"
                ? `وَلَّد ${lastSpawn} مصروف`
                : `Generated ${lastSpawn} expense${lastSpawn === 1 ? "" : "s"}`}
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={handleGenerate}
            disabled={generating}
          >
            <RotateCcw className="w-4 h-4 me-1" />
            {generating
              ? locale === "ar" ? "جار التوليد..." : "Generating..."
              : locale === "ar" ? "توليد الآن" : "Generate now"}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 me-1" />
            {locale === "ar" ? "قالب جديد" : "New template"}
          </Button>
        </div>
      </div>

      {forbidden ? (
        <ForbiddenPanel />
      ) : loading ? (
        <PageSkeleton rows={4} />
      ) : error ? (
        <div className="bg-white rounded-xl border border-danger-light p-5 text-sm text-danger">
          {error}
        </div>
      ) : !templates || templates.length === 0 ? (
        <EmptyState type="sales" message={t.empty.hint} />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-main text-text-secondary text-xs uppercase">
              <tr>
                <th className="text-start px-4 py-3">
                  {locale === "ar" ? "العنوان" : "Title"}
                </th>
                <th className="text-start px-4 py-3">
                  {locale === "ar" ? "الفئة" : "Category"}
                </th>
                <th className="text-end px-4 py-3">
                  {locale === "ar" ? "المبلغ" : "Amount"}
                </th>
                <th className="text-end px-4 py-3">
                  {locale === "ar" ? "الحالة" : "Status"}
                </th>
              </tr>
            </thead>
            <tbody>
              {templates.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-text-primary">
                    {row.title}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {row.categoryLabel ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-end tabular-nums">
                    {formatCurrency(row.amount, locale)}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Badge variant={row.isActive ? "sold" : "other"}>
                      {row.isActive
                        ? locale === "ar" ? "نشط" : "Active"
                        : locale === "ar" ? "متوقف" : "Inactive"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <TemplateFormModal
          categories={tree ?? []}
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function TemplateFormModal({
  categories,
  onClose,
  onSaved,
}: {
  categories: { id: string; nameEn: string; nameAr: string; children: unknown[] }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const locale = useLocale();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [period, setPeriod] = useState<"monthly" | "weekly">("monthly");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flatten category tree to leaves only for the picker.
  const leaves = flatten(categories, locale === "ar");

  async function submit() {
    setError(null);
    const amt = Number(amount);
    if (!title.trim() || !Number.isFinite(amt) || amt < 0 || !categoryId) {
      setError(locale === "ar" ? "بيانات ناقصة" : "Missing fields");
      return;
    }
    setSubmitting(true);
    try {
      // Templates are created via the LEGACY /api/expenses endpoint (which
      // supports `isRecurring` + `recurrencePeriod`). The new Financials
      // expense route doesn't expose those yet — kept to the posted path for
      // Slice 1 simplicity. Both end up in the same `expenses` table.
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          amount: amt,
          category: "other", // legacy enum — real category below in categoryId follow-up PATCH
          isRecurring: true,
          recurrencePeriod: period,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `failed (${res.status})`);
      }
      const { id } = (await res.json()) as { id: string };
      // Attach the real categoryId via the Financials PATCH route.
      await fetch(`/api/financials/expenses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      });
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
      title={locale === "ar" ? "قالب دوري جديد" : "New recurring template"}
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
          <Select
            label={locale === "ar" ? "التكرار" : "Period"}
            value={period}
            onChange={(e) => setPeriod(e.target.value as "monthly" | "weekly")}
            options={[
              { value: "monthly", label: locale === "ar" ? "شهري" : "Monthly" },
              { value: "weekly", label: locale === "ar" ? "أسبوعي" : "Weekly" },
            ]}
          />
        </div>
        <Select
          label={locale === "ar" ? "الفئة" : "Category"}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          placeholder={locale === "ar" ? "اختر الفئة" : "Pick a category"}
          options={leaves}
          required
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

interface CatNode {
  id: string;
  nameEn: string;
  nameAr: string;
  children: CatNode[];
}

function flatten(nodes: CatNode[] | { id: string; nameEn: string; nameAr: string; children: unknown[] }[], isRtl: boolean): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (list: unknown[], parent = "") => {
    for (const raw of list) {
      const n = raw as CatNode;
      const label = isRtl ? n.nameAr : n.nameEn;
      const fullLabel = parent ? `${parent} › ${label}` : label;
      if (!n.children || n.children.length === 0) {
        out.push({ value: n.id, label: fullLabel });
      }
      if (n.children && n.children.length > 0) walk(n.children, fullLabel);
    }
  };
  walk(nodes);
  return out;
}

function ForbiddenPanel() {
  const locale = useLocale();
  const title = locale === "ar" ? "ليست لديك صلاحية الوصول" : "You don't have access";
  const hint =
    locale === "ar"
      ? "تحتاج صلاحية view_financials وmanage_recurring_expenses."
      : "You need view_financials and manage_recurring_expenses.";
  return (
    <div className="bg-white rounded-xl border border-border p-8 text-center space-y-2">
      <h3 className="font-semibold text-text-primary">{title}</h3>
      <p className="text-sm text-text-secondary">{hint}</p>
    </div>
  );
}
