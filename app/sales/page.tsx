"use client";

import { useState, useMemo } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useSales } from "@/hooks/useSales";
import { useReturns } from "@/hooks/useReturns";
import { useProducts } from "@/hooks/useProducts";
import { SaleForm, type ReceiptSaleData } from "@/components/sales/SaleForm";
import { PrintOptionsModal } from "@/components/sales/PrintOptionsModal";
import { SaleSummaryCard } from "@/components/sales/SaleSummaryCard";
import { SalesFilters } from "@/components/sales/SalesFilters";
import { SalesTable } from "@/components/sales/SalesTable";
import { SaleCard } from "@/components/sales/SaleCard";
import { ReturnModal } from "@/components/returns/ReturnModal";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Toast } from "@/components/ui/Toast";
import type { Sale, Category } from "@/lib/types";

export default function SalesPage() {
  const { sales, loading: salesLoading } = useSales();
  const { returns } = useReturns();
  const { products } = useProducts();

  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<"all" | "sold" | "returned">("all");

  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptSaleData | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const filteredSales = useMemo(() => {
    return sales.filter((s) => {
      if (selectedCategory && s.category !== selectedCategory) return false;
      if (selectedStatus === "sold" && s.isReturned) return false;
      if (selectedStatus === "returned" && !s.isReturned) return false;
      return true;
    });
  }, [sales, selectedCategory, selectedStatus]);

  const handleReturn = (sale: Sale) => {
    setReturnSale(sale);
  };

  const handlePrint = (sale: Sale) => {
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

  if (salesLoading) {
    return (
      <AppShell title="المبيعات">
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="المبيعات">
      <div className="space-y-4">
        <SaleSummaryCard />

        {/* Sale Form */}
        <SaleForm
          onSuccess={() => setToast({ type: "success", message: "تم تسجيل البيع بنجاح" })}
          onPrintLastSale={setReceiptData}
        />

        {/* Filters */}
        <SalesFilters
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          selectedStatus={selectedStatus}
          onStatusChange={setSelectedStatus}
        />

        {/* Empty State */}
        {filteredSales.length === 0 && (
          <EmptyState type="sales" />
        )}

        {/* Desktop Table */}
        <div className="hidden md:block">
          <SalesTable sales={filteredSales} onReturn={handleReturn} onPrint={handlePrint} />
        </div>

        {/* Mobile Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:hidden">
          {filteredSales.map((sale) => (
            <SaleCard key={sale.id} sale={sale} onReturn={handleReturn} onPrint={handlePrint} />
          ))}
        </div>
      </div>

      <ReturnModal
        isOpen={!!returnSale}
        onClose={() => setReturnSale(null)}
        sale={returnSale}
        onSuccess={handleReturnSuccess}
      />

      {/* Print Options Modal — owns the printable container */}
      <PrintOptionsModal
        isOpen={!!receiptData}
        onClose={() => setReceiptData(null)}
        receiptData={receiptData}
        onConfirm={() => setReceiptData(null)}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}