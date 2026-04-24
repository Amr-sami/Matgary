"use client";

import { useState, useMemo } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useSales } from "@/hooks/useSales";
import { useReturns } from "@/hooks/useReturns";
import { useProducts } from "@/hooks/useProducts";
import { SaleForm } from "@/components/sales/SaleForm";
import { SaleSummaryCard } from "@/components/sales/SaleSummaryCard";
import { SalesFilters } from "@/components/sales/SalesFilters";
import { SalesTable } from "@/components/sales/SalesTable";
import { SaleCard } from "@/components/sales/SaleCard";
import { ReturnModal } from "@/components/returns/ReturnModal";
import { Receipt } from "@/components/sales/Receipt";
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
  const [printSale, setPrintSale] = useState<Sale | null>(null);
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
    setPrintSale(sale);
    // Use a small timeout to ensure the Receipt component is rendered before printing
    setTimeout(() => {
      window.print();
    }, 100);
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

      {/* Hidden Receipt for Printing */}
      {printSale && (
        <div className="print-receipt-container">
          <Receipt 
            sale={{
              productName: printSale.productName,
              brand: printSale.brand,
              quantity: printSale.quantitySold,
              pricePerUnit: printSale.pricePerUnit,
              subtotal: printSale.subtotal,
              discountType: printSale.discountType,
              discountValue: printSale.discountValue,
              discountAmount: printSale.discountAmount || 0,
              totalPrice: printSale.totalPrice,
              saleDate: printSale.saleDate,
            }} 
          />
        </div>
      )}

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </AppShell>
  );
}