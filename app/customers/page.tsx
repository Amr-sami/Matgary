"use client";

import { useMemo, useState } from "react";
import { Download, Users, Star, Wallet, Bell, Megaphone } from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { useCustomersData } from "@/hooks/useCustomersData";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { CustomerRow } from "@/components/customers/CustomerRow";
import { downloadCsv } from "@/lib/csv";
import {
  buildCustomerAggregatesGeneric,
  customersToCsv,
  daysSince,
  type CustomerAggregate,
} from "@/lib/customers";
import { formatPrice } from "@/lib/utils";

const BUILD_STAMP = "2026-04-30-customer-invoices-v4";

type SortKey = "ltv" | "recent" | "invoices" | "outstanding" | "name";
type Filter = "all" | "repeat" | "inactive" | "outstanding";

const SORT_LABELS: Record<SortKey, string> = {
  ltv: "الأعلى إنفاقاً",
  recent: "الأحدث زيارة",
  invoices: "الأكثر فواتير",
  outstanding: "أعلى آجل غير مدفوع",
  name: "الاسم",
};

export default function CustomersPage() {
  // Hook auto-refetches on tab focus + visibility, so the list reflects
  // changes made on the customer detail page when the user navigates back.
  // We also pass `refresh` down so inline mark-paid actions inside
  // CustomerRow can re-aggregate without a hard reload.
  const { records, loading, refresh: refreshRecords } = useCustomersData();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("ltv");
  const [filter, setFilter] = useState<Filter>("all");

  const customers = useMemo(
    () => buildCustomerAggregatesGeneric(records),
    [records]
  );

  // Diagnostic: how many sales had any customer info attached
  const salesWithCustomer = useMemo(
    () =>
      records.filter(
        (s) =>
          !s.isReturned &&
          ((s.customerName || "").trim() || (s.customerPhone || "").trim())
      ).length,
    [records]
  );
  const totalActiveSales = useMemo(
    () => records.filter((s) => !s.isReturned).length,
    [records]
  );
  const latestSale = useMemo(
    () =>
      [...records]
        .filter((s) => !s.isReturned)
        .sort((a, b) => b.saleDate.getTime() - a.saleDate.getTime())[0],
    [records]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = customers.filter((c) => {
      if (q) {
        const hay = `${c.name} ${c.phone || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === "repeat" && c.invoiceCount < 3) return false;
      if (filter === "inactive" && daysSince(c.lastVisit) < 60) return false;
      if (filter === "outstanding" && c.outstandingBalance <= 0) return false;
      return true;
    });
    list.sort((a, b) => {
      switch (sort) {
        case "ltv":
          return b.lifetimeValue - a.lifetimeValue;
        case "recent":
          return b.lastVisit.getTime() - a.lastVisit.getTime();
        case "invoices":
          return b.invoiceCount - a.invoiceCount;
        case "outstanding":
          return b.outstandingBalance - a.outstandingBalance;
        case "name":
          return a.name.localeCompare(b.name, "ar");
      }
    });
    return list;
  }, [customers, query, filter, sort]);

  const top5 = useMemo(
    () =>
      [...customers].sort((a, b) => b.lifetimeValue - a.lifetimeValue).slice(0, 5),
    [customers]
  );

  const totals = useMemo(() => {
    const total = customers.length;
    const repeats = customers.filter((c) => c.invoiceCount >= 3).length;
    const inactive = customers.filter(
      (c) => daysSince(c.lastVisit) >= 60
    ).length;
    const outstanding = customers.reduce((s, c) => s + c.outstandingBalance, 0);
    return { total, repeats, inactive, outstanding };
  }, [customers]);

  const handleExport = () => {
    if (filtered.length === 0) return;
    const csv = customersToCsv(filtered);
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`customers-${date}.csv`, csv);
  };

  const handleBulkInactive = () => {
    const inactive = customers.filter(
      (c) => daysSince(c.lastVisit) >= 60 && c.phone
    );
    if (inactive.length === 0) return;
    const message =
      "أهلاً! وحشتنا في Corner Store. تشكيلتنا الجديدة وصلت — بنستناك 🌟";
    const phones = inactive.map((c) => c.phone!.replace(/\D/g, "")).join(",");
    // Open WhatsApp web with the first number; user can broadcast manually.
    // wa.me does not support multi-recipient; we copy the message and open one.
    const url = `https://wa.me/${inactive[0].phone!.replace(/\D/g, "")}?text=${encodeURIComponent(
      message
    )}`;
    navigator.clipboard
      .writeText(`${inactive.length} رقم:\n${phones}\n\nرسالة:\n${message}`)
      .catch(() => {});
    window.open(url, "_blank");
  };

  if (loading) {
    return (
      <AppShell title="العملاء">
        <PageSkeleton rows={7} cards={false} />
      </AppShell>
    );
  }

  return (
    <AppShell title="العملاء">
      <div className="space-y-4">
        {/* Diagnostic: explain when nothing is showing */}
        {customers.length === 0 && totalActiveSales > 0 && (
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900 space-y-2">
            <p className="font-bold">لا يوجد عملاء بعد</p>
            <p>
              عندك {totalActiveSales} فاتورة في النظام، لكن لم يتم إدخال اسم
              أو رقم العميل في أي منها.
            </p>
            <p className="text-xs">
              الحل: عند تسجيل البيع، اكتب اسم العميل أو رقم الموبايل في حقول
              "العميل" قبل الضغط على "تسجيل الفاتورة".
            </p>
            {latestSale && (
              <div className="mt-2 p-2 rounded bg-white border border-orange-100 text-xs font-mono space-y-0.5 text-text-primary">
                <p className="font-sans text-text-secondary">
                  أحدث فاتورة (للتشخيص):
                </p>
                <p>id: {latestSale.id.slice(-8)}</p>
                <p>productName: {latestSale.productName}</p>
                <p>
                  customerName:{" "}
                  <span
                    className={
                      latestSale.customerName
                        ? "text-success font-bold"
                        : "text-danger font-bold"
                    }
                  >
                    {latestSale.customerName ?? "(غير موجود)"}
                  </span>
                </p>
                <p>
                  customerPhone:{" "}
                  <span
                    className={
                      latestSale.customerPhone
                        ? "text-success font-bold"
                        : "text-danger font-bold"
                    }
                  >
                    {latestSale.customerPhone ?? "(غير موجود)"}
                  </span>
                </p>
                <p>paymentMethod: {latestSale.paymentMethod ?? "(غير موجود)"}</p>
              </div>
            )}
            <p className="text-xs italic">
              لو ظهر "غير موجود" مع إنك سجلت اسم/رقم: المتصفح بيحمّل نسخة قديمة
              من البرنامج. اعمل hard refresh: Ctrl+Shift+R (ويندوز) أو
              Cmd+Shift+R (ماك)، أو افتح الصفحة في incognito.
            </p>
            <p className="text-[10px] text-text-secondary">
              build: {BUILD_STAMP}
            </p>
          </div>
        )}
        {customers.length > 0 && salesWithCustomer < totalActiveSales && (
          <div className="rounded-xl border border-accent-light bg-accent-light/30 p-3 text-xs text-text-secondary">
            تم ربط بيانات العملاء بـ {salesWithCustomer} من أصل {totalActiveSales} فاتورة.
            باقي الفواتير لم يتم تسجيل اسم/رقم لها.
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            icon={<Users className="w-5 h-5" />}
            label="إجمالي العملاء"
            value={String(totals.total)}
          />
          <SummaryCard
            icon={<Star className="w-5 h-5" />}
            label="عملاء دائمون"
            value={String(totals.repeats)}
            tone="accent"
          />
          <SummaryCard
            icon={<Bell className="w-5 h-5" />}
            label="غير نشطين"
            value={String(totals.inactive)}
            tone="warning"
          />
          <SummaryCard
            icon={<Wallet className="w-5 h-5" />}
            label="آجل غير مدفوع"
            value={formatPrice(totals.outstanding)}
            tone={totals.outstanding > 0 ? "warning" : "default"}
          />
        </div>

        {/* Top 5 by LTV */}
        {top5.length > 0 && (
          <div className="bg-white rounded-xl border border-border p-4">
            <div className="flex items-center gap-2 mb-3">
              <Star className="w-5 h-5 text-accent" />
              <p className="font-bold">أعلى 5 عملاء إنفاقاً</p>
            </div>
            <ul className="space-y-2">
              {top5.map((c, idx) => (
                <li
                  key={c.key}
                  className="flex items-center justify-between text-sm gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-5 h-5 rounded-full bg-accent-light text-accent text-xs flex items-center justify-center font-bold shrink-0">
                      {idx + 1}
                    </span>
                    <span className="truncate">{c.name}</span>
                    {c.phone && (
                      <span className="text-[10px] text-text-secondary">
                        {c.phone}
                      </span>
                    )}
                  </div>
                  <div className="text-end shrink-0">
                    <p className="font-bold">{formatPrice(c.lifetimeValue)}</p>
                    <p className="text-[10px] text-text-secondary">
                      {c.invoiceCount} فاتورة
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Search + sort + filter + actions */}
        <div className="bg-white rounded-xl border border-border p-3 space-y-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالاسم أو الموبايل..."
            dir="rtl"
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                dir="rtl"
                className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
              >
                <option value="all">كل العملاء</option>
                <option value="repeat">عملاء دائمون</option>
                <option value="inactive">غير نشط (60+ يوم)</option>
                <option value="outstanding">عليه آجل</option>
              </select>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                dir="rtl"
                className="px-3 py-1.5 rounded-lg border border-border bg-white text-sm"
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <option key={k} value={k}>
                    ترتيب: {SORT_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              {totals.inactive > 0 && (
                <button
                  onClick={handleBulkInactive}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-orange-100 text-orange-700 text-xs font-medium hover:bg-orange-200"
                  title="ينسخ كل أرقام العملاء غير النشطين ويفتح واتساب على أول رقم"
                >
                  <Megaphone className="w-3.5 h-3.5" />
                  مراسلة غير النشطين
                </button>
              )}
              <button
                onClick={handleExport}
                disabled={filtered.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-border text-text-secondary text-xs hover:border-accent disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                تصدير CSV
              </button>
            </div>
          </div>
        </div>

        <p className="text-sm text-text-secondary px-1">
          {filtered.length} عميل
        </p>

        {filtered.length === 0 && (
          <EmptyState
            type="sales"
            message={
              customers.length === 0
                ? "لم يتم تسجيل أي عملاء بعد. أضف الاسم/الموبايل عند تسجيل البيع."
                : "لا توجد نتائج"
            }
          />
        )}

        <div className="space-y-3">
          {filtered.map((c) => (
            <CustomerRow
              key={c.key}
              customer={c}
              records={records}
              onChange={() => refreshRecords(false)}
            />
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning";
}) {
  const cls =
    tone === "warning"
      ? "border-orange-200 bg-orange-50"
      : tone === "accent"
        ? "border-accent/20 bg-accent-light/30"
        : "border-border bg-white";
  const iconCls =
    tone === "warning"
      ? "text-orange-600"
      : tone === "accent"
        ? "text-accent"
        : "text-text-secondary";
  return (
    <div className={`rounded-xl p-4 border ${cls}`}>
      <div className={`flex items-center gap-2 mb-1 ${iconCls}`}>
        {icon}
        <span className="text-xs text-text-secondary">{label}</span>
      </div>
      <p className="text-lg font-bold leading-tight">{value}</p>
    </div>
  );
}
