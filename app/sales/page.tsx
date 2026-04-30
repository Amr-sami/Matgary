"use client";

import { useState, useMemo, useCallback, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { useSales } from "@/hooks/useSales";
import { useReturns } from "@/hooks/useReturns";
import { useProducts } from "@/hooks/useProducts";
import { SaleForm, type ReceiptSaleData, type ReceiptInvoiceData } from "@/components/sales/SaleForm";
import { PrintOptionsModal } from "@/components/sales/PrintOptionsModal";
import {
  SalesFilters,
  type DateRangeKey,
  type SalesSortKey,
} from "@/components/sales/SalesFilters";
import { SalesKpiCards } from "@/components/sales/SalesKpiCards";
import { DeferredPanel } from "@/components/sales/DeferredPanel";
import { DayCompareCard } from "@/components/sales/DayCompareCard";
import { SalesChart } from "@/components/sales/SalesChart";
import { TopProductsCard } from "@/components/sales/TopProductsCard";
import { TopCustomersCard } from "@/components/sales/TopCustomersCard";
import { HourHeatmap } from "@/components/sales/HourHeatmap";
import { SalesTable } from "@/components/sales/SalesTable";
import { SaleCard } from "@/components/sales/SaleCard";
import { SalesBulkActions } from "@/components/sales/SalesBulkActions";
import { EditSaleModal } from "@/components/sales/EditSaleModal";
import { ReturnModal } from "@/components/returns/ReturnModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Toast } from "@/components/ui/Toast";
import { Pagination } from "@/components/ui/Pagination";
import { voidSale } from "@/lib/firestore";
import { salesToCsv, downloadCsv } from "@/lib/csv";
import type { Sale, Category, Gender } from "@/lib/types";

export default function SalesPage() {
  return (
    <Suspense
      fallback={
        <AppShell title="المبيعات">
          <div className="flex items-center justify-center py-20">
            <LoadingSpinner />
          </div>
        </AppShell>
      }
    >
      <SalesPageInner />
    </Suspense>
  );
}

function rangeToDates(
  range: DateRangeKey,
  customFrom: string,
  customTo: string
): { start: Date | null; end: Date | null } {
  const now = new Date();
  const startOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  };
  const endOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(23, 59, 59, 999);
    return c;
  };

  switch (range) {
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case "7d": {
      const s = new Date(now);
      s.setDate(now.getDate() - 6);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case "30d": {
      const s = new Date(now);
      s.setDate(now.getDate() - 29);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case "thisMonth":
      return {
        start: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)),
        end: endOfDay(now),
      };
    case "custom":
      return {
        start: customFrom ? startOfDay(new Date(customFrom)) : null,
        end: customTo ? endOfDay(new Date(customTo)) : null,
      };
    case "all":
    default:
      return { start: null, end: null };
  }
}

function SalesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { sales, loading: salesLoading } = useSales();
  const { returns: _returns } = useReturns();
  const { products: _products } = useProducts();

  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(
    (searchParams.get("cat") as Category | null) || null
  );
  const [selectedGender, setSelectedGender] = useState<Gender | null>(
    (searchParams.get("gen") as Gender | null) || null
  );
  const [selectedStatus, setSelectedStatus] = useState<"all" | "sold" | "returned">(
    (searchParams.get("status") as any) || "all"
  );
  const [selectedBrand, setSelectedBrand] = useState<string | null>(
    searchParams.get("brand") || null
  );
  const [dateRange, setDateRange] = useState<DateRangeKey>(
    (searchParams.get("range") as DateRangeKey) || "30d"
  );
  const [customFrom, setCustomFrom] = useState(searchParams.get("from") || "");
  const [customTo, setCustomTo] = useState(searchParams.get("to") || "");
  const [discountOnly, setDiscountOnly] = useState(searchParams.get("disc") === "1");
  const [sort, setSort] = useState<SalesSortKey>(
    (searchParams.get("sort") as SalesSortKey) || "newest"
  );
  const [page, setPage] = useState(Number(searchParams.get("p") || "1"));
  const [pageSize, setPageSize] = useState(Number(searchParams.get("ps") || "50"));

  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [editSale, setEditSale] = useState<Sale | null>(null);
  const [voidSaleData, setVoidSaleData] = useState<Sale | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptSaleData | null>(null);
  const [invoiceReceipt, setInvoiceReceipt] = useState<ReceiptInvoiceData | null>(null);
  const [printQueue, setPrintQueue] = useState<Sale[]>([]);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Persist URL state
  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedCategory) params.set("cat", selectedCategory);
    if (selectedGender) params.set("gen", selectedGender);
    if (selectedStatus !== "all") params.set("status", selectedStatus);
    if (selectedBrand) params.set("brand", selectedBrand);
    if (dateRange !== "30d") params.set("range", dateRange);
    if (customFrom) params.set("from", customFrom);
    if (customTo) params.set("to", customTo);
    if (discountOnly) params.set("disc", "1");
    if (sort !== "newest") params.set("sort", sort);
    if (page !== 1) params.set("p", String(page));
    if (pageSize !== 50) params.set("ps", String(pageSize));
    const qs = params.toString();
    router.replace(qs ? `/sales?${qs}` : "/sales", { scroll: false });
  }, [
    selectedCategory,
    selectedGender,
    selectedStatus,
    selectedBrand,
    dateRange,
    customFrom,
    customTo,
    discountOnly,
    sort,
    page,
    pageSize,
    router,
  ]);

  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const s of sales) {
      if (s.brand && s.brand.trim()) set.add(s.brand.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ar"));
  }, [sales]);

  const { start, end } = useMemo(
    () => rangeToDates(dateRange, customFrom, customTo),
    [dateRange, customFrom, customTo]
  );

  const dateRangedSales = useMemo(() => {
    return sales.filter((s) => {
      const t = s.saleDate.getTime();
      if (start && t < start.getTime()) return false;
      if (end && t > end.getTime()) return false;
      return true;
    });
  }, [sales, start, end]);

  const filteredSales = useMemo(() => {
    const q = query.trim().toLowerCase();
    const result = dateRangedSales.filter((s) => {
      if (selectedCategory && s.category !== selectedCategory) return false;
      if (selectedGender && s.gender !== selectedGender) return false;
      if (selectedBrand && s.brand !== selectedBrand) return false;
      if (selectedStatus === "sold" && s.isReturned) return false;
      if (selectedStatus === "returned" && !s.isReturned) return false;
      if (discountOnly && !(s.discountAmount && s.discountAmount > 0)) return false;
      if (q) {
        const hay =
          `${s.productName} ${s.brand || ""} ${s.note || ""} ${s.customerName || ""} ${s.customerPhone || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...result];
    sorted.sort((a, b) => {
      switch (sort) {
        case "newest":
          return b.saleDate.getTime() - a.saleDate.getTime();
        case "oldest":
          return a.saleDate.getTime() - b.saleDate.getTime();
        case "totalDesc":
          return b.totalPrice - a.totalPrice;
        case "totalAsc":
          return a.totalPrice - b.totalPrice;
        case "qtyDesc":
          return b.quantitySold - a.quantitySold;
        case "qtyAsc":
          return a.quantitySold - b.quantitySold;
      }
    });
    return sorted;
  }, [
    dateRangedSales,
    selectedCategory,
    selectedGender,
    selectedBrand,
    selectedStatus,
    discountOnly,
    query,
    sort,
  ]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredSales.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filteredSales.length, pageSize, page]);

  const pagedSales = useMemo(() => {
    const startIdx = (page - 1) * pageSize;
    return filteredSales.slice(startIdx, startIdx + pageSize);
  }, [filteredSales, page, pageSize]);

  const selectedSales = useMemo(
    () => filteredSales.filter((s) => selectedIds.has(s.id)),
    [filteredSales, selectedIds]
  );

  const toggleSelect = useCallback((sale: Sale) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sale.id)) next.delete(sale.id);
      else next.add(sale.id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allOnPage = pagedSales.every((s) => prev.has(s.id));
      const next = new Set(prev);
      if (allOnPage) for (const s of pagedSales) next.delete(s.id);
      else for (const s of pagedSales) next.add(s.id);
      return next;
    });
  }, [pagedSales]);

  const handleCustomerClick = (sale: Sale) => {
    const value = sale.customerPhone || sale.customerName || "";
    if (!value) return;
    setQuery(value);
    setDateRange("all");
    setSelectedStatus("all");
  };
  const handleReturn = (sale: Sale) => setReturnSale(sale);
  const handlePrint = (sale: Sale) => {
    // If the sale belongs to a multi-line invoice, print the whole invoice
    if (sale.invoiceId) {
      const lines = sales.filter(
        (s) => s.invoiceId === sale.invoiceId && !s.isReturned
      );
      if (lines.length > 1) {
        const cartSubtotal = lines.reduce((s, l) => s + l.subtotal, 0);
        const totalPrice = lines.reduce((s, l) => s + l.totalPrice, 0);
        const discountTotal = lines.reduce(
          (s, l) => s + (l.discountAmount || 0),
          0
        );
        setInvoiceReceipt({
          invoiceId: sale.invoiceId,
          saleDate: sale.saleDate,
          lines: lines.map((l) => ({
            productName: l.productName,
            brand: l.brand,
            quantity: l.quantitySold,
            pricePerUnit: l.pricePerUnit,
            subtotal: l.subtotal,
            lineDiscountAmount: l.discountAmount || 0,
          })),
          cartSubtotal,
          orderDiscountAmount: Math.max(0, cartSubtotal - totalPrice - discountTotal),
          totalPrice,
          note: sale.note,
        });
        return;
      }
    }
    setReceiptData({
      saleId: sale.id,
      productName: sale.productName,
      brand: sale.brand,
      quantity: sale.quantitySold,
      pricePerUnit: sale.pricePerUnit,
      subtotal: sale.subtotal,
      discountType: sale.discountType,
      discountValue: sale.discountValue,
      discountAmount: sale.discountAmount || 0,
      totalPrice: sale.totalPrice,
      saleDate: sale.saleDate,
    });
  };
  const handleReturnSuccess = () => {
    setToast({ type: "success", message: "تم تسجيل المرتجع وتحديث المخزن" });
  };

  const handleVoidConfirm = useCallback(async () => {
    if (!voidSaleData) return;
    try {
      await voidSale(voidSaleData.id);
      setToast({
        type: "success",
        message: voidSaleData.isReturned
          ? "تم حذف الفاتورة"
          : "تم حذف الفاتورة وإرجاع المخزون",
      });
    } catch (e: any) {
      setToast({ type: "error", message: e.message || "تعذر الحذف" });
    } finally {
      setVoidSaleData(null);
    }
  }, [voidSaleData]);

  const handleBulkExport = useCallback(() => {
    if (selectedSales.length === 0) return;
    const csv = salesToCsv(selectedSales);
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`sales-selected-${date}.csv`, csv);
  }, [selectedSales]);

  // Print all selected sequentially: enqueue and process via printQueue + receiptData
  const handlePrintAll = useCallback(() => {
    if (selectedSales.length === 0) return;
    const valid = selectedSales.filter((s) => !s.isReturned);
    if (valid.length === 0) {
      setToast({ type: "error", message: "لا توجد فواتير صالحة للطباعة في التحديد" });
      return;
    }
    setPrintQueue(valid);
  }, [selectedSales]);

  // Drive the print queue: when receiptData closes, advance
  useEffect(() => {
    if (!receiptData && printQueue.length > 0) {
      const [next, ...rest] = printQueue;
      setReceiptData({
        saleId: next.id,
        productName: next.productName,
        brand: next.brand,
        quantity: next.quantitySold,
        pricePerUnit: next.pricePerUnit,
        subtotal: next.subtotal,
        discountType: next.discountType,
        discountValue: next.discountValue,
        discountAmount: next.discountAmount || 0,
        totalPrice: next.totalPrice,
        saleDate: next.saleDate,
      });
      setPrintQueue(rest);
    }
  }, [receiptData, printQueue]);

  const handleResetFilters = () => {
    setSelectedCategory(null);
    setSelectedGender(null);
    setSelectedStatus("all");
    setSelectedBrand(null);
    setDiscountOnly(false);
    setQuery("");
    setDateRange("30d");
    setCustomFrom("");
    setCustomTo("");
  };

  if (salesLoading) {
    return (
      <AppShell title="المبيعات">
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner />
        </div>
      </AppShell>
    );
  }

  const rangeLabel =
    dateRange === "today"
      ? "اليوم"
      : dateRange === "yesterday"
        ? "أمس"
        : dateRange === "7d"
          ? "آخر 7 أيام"
          : dateRange === "30d"
            ? "آخر 30 يوم"
            : dateRange === "thisMonth"
              ? "الشهر"
              : dateRange === "custom"
                ? "الفترة المختارة"
                : "الكل";

  return (
    <AppShell title="المبيعات">
      <div className="space-y-4">
        {/* KPIs over the date-ranged sales */}
        <SalesKpiCards sales={dateRangedSales} rangeLabel={rangeLabel} />

        {/* Outstanding deferred (across all time) */}
        <DeferredPanel sales={sales} />

        {/* Sale Form */}
        <SaleForm
          onSuccess={() => setToast({ type: "success", message: "تم تسجيل البيع بنجاح" })}
          onPrintLastSale={setReceiptData}
          onPrintLastInvoice={setInvoiceReceipt}
        />

        {/* Insights row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <SalesChart sales={dateRangedSales} days={30} />
          </div>
          <TopProductsCard sales={dateRangedSales} />
        </div>
        <TopCustomersCard sales={dateRangedSales} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <HourHeatmap sales={dateRangedSales} />
          </div>
          <DayCompareCard sales={sales} />
        </div>

        {/* Filters */}
        <SalesFilters
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          selectedGender={selectedGender}
          onGenderChange={setSelectedGender}
          selectedStatus={selectedStatus}
          onStatusChange={setSelectedStatus}
          selectedBrand={selectedBrand}
          onBrandChange={setSelectedBrand}
          brands={brands}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
          discountOnly={discountOnly}
          onDiscountOnlyChange={setDiscountOnly}
          sort={sort}
          onSortChange={setSort}
          query={query}
          onQueryChange={setQuery}
        />

        <div className="flex items-center justify-between">
          <button
            onClick={handleResetFilters}
            className="px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:text-accent border border-border bg-white"
          >
            مسح الفلاتر
          </button>
          <span className="text-sm text-text-secondary">
            {filteredSales.length} فاتورة
          </span>
        </div>

        {/* Bulk actions */}
        <SalesBulkActions
          selected={selectedSales}
          onClear={() => setSelectedIds(new Set())}
          onExport={handleBulkExport}
          onPrintAll={handlePrintAll}
        />

        {/* Empty State */}
        {filteredSales.length === 0 && <EmptyState type="sales" />}

        {/* Desktop Table */}
        {filteredSales.length > 0 && (
          <div className="hidden md:block">
            <SalesTable
              sales={pagedSales}
              onReturn={handleReturn}
              onPrint={handlePrint}
              onEdit={setEditSale}
              onVoid={setVoidSaleData}
              onCustomerClick={handleCustomerClick}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
          </div>
        )}

        {/* Mobile Cards */}
        {filteredSales.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:hidden">
            {pagedSales.map((sale) => (
              <SaleCard
                key={sale.id}
                sale={sale}
                onReturn={handleReturn}
                onPrint={handlePrint}
                onEdit={setEditSale}
                onVoid={setVoidSaleData}
                onCustomerClick={handleCustomerClick}
                selected={selectedIds.has(sale.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}

        {filteredSales.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={filteredSales.length}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        )}
      </div>

      <ReturnModal
        isOpen={!!returnSale}
        onClose={() => setReturnSale(null)}
        sale={returnSale}
        onSuccess={handleReturnSuccess}
      />

      <EditSaleModal
        isOpen={!!editSale}
        onClose={() => setEditSale(null)}
        sale={editSale}
        onSuccess={() => setToast({ type: "success", message: "تم تحديث الفاتورة" })}
      />

      <ConfirmDialog
        isOpen={!!voidSaleData}
        onClose={() => setVoidSaleData(null)}
        onConfirm={handleVoidConfirm}
        title="حذف الفاتورة"
        message={
          voidSaleData?.isReturned
            ? "هذه الفاتورة مرتجعة بالفعل. سيتم حذفها بشكل نهائي."
            : `سيتم حذف الفاتورة وإرجاع ${voidSaleData?.quantitySold || 0} قطعة من "${voidSaleData?.productName}" إلى المخزن.`
        }
        confirmText="حذف"
        variant="danger"
      />

      <PrintOptionsModal
        isOpen={!!receiptData || !!invoiceReceipt}
        onClose={() => {
          setReceiptData(null);
          setInvoiceReceipt(null);
        }}
        receiptData={receiptData}
        invoiceData={invoiceReceipt}
        onConfirm={() => {
          setReceiptData(null);
          setInvoiceReceipt(null);
        }}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}
