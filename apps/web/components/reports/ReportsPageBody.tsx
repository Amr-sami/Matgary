"use client";

// Client island for /reports. Holds the date range state, the
// filtered/aggregated data, the print state, and the entire data
// fetch. Page shell + heading render on the server.

import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { DateRangePicker } from "./DateRangePicker";
import { StatCard } from "../dashboard/StatCard";
import { SalesTable } from "../sales/SalesTable";
import { SaleCard } from "../sales/SaleCard";
import { Receipt } from "../sales/Receipt";
import { useSales } from "@/hooks/useSales";
import { useReturns } from "@/hooks/useReturns";
import { PageSkeleton } from "../ui/PageSkeleton";
import { EmptyState } from "../ui/EmptyState";
import {
  startOfDay,
  endOfDay,
  isBetween,
  getTodayRange,
  getThisMonthRange,
} from "@/lib/utils";
import { DollarSign, ShoppingCart, RotateCcw } from "@/lib/icons";
import type { Sale } from "@/lib/types";
import { formatCurrency } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";

export interface ReportsPageBodyProps {
  locale: Locale;
  strings: {
    totalSales: string;
    totalQty: string;
    qtySuffix: string;
    totalReturns: string;
    returnsSubtitle: string;
    detailsHeading: string;
  };
}

export function ReportsPageBody({ locale, strings }: ReportsPageBodyProps) {
  const searchParams = useSearchParams();
  // Reports aggregate over arbitrary user-selected date ranges, so we
  // opt out of the server's default 60-day window via `all: true`.
  const { sales, loading: salesLoading } = useSales({ all: true });
  const { returns, loading: returnsLoading } = useReturns({ all: true });

  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [printSale, setPrintSale] = useState<Sale | null>(null);

  useEffect(() => {
    const range = searchParams.get("range");
    let start = new Date();
    let end = new Date();
    if (range === "today") {
      ({ start, end } = getTodayRange());
    } else if (range === "this-month" || range === "returns-this-month") {
      ({ start, end } = getThisMonthRange());
    } else {
      ({ start, end } = getThisMonthRange());
    }
    setDateRange({
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
    });
  }, [searchParams]);

  const filteredData = useMemo(() => {
    if (!dateRange.start || !dateRange.end) return { sales: [], returns: [] };
    const start = startOfDay(new Date(dateRange.start));
    const end = endOfDay(new Date(dateRange.end));
    const fSales = sales.filter((s) => isBetween(new Date(s.saleDate), start, end));
    const fReturns = returns.filter((r) => isBetween(new Date(r.returnDate), start, end));
    return { sales: fSales, returns: fReturns };
  }, [sales, returns, dateRange]);

  const stats = useMemo(() => {
    const totalSales = filteredData.sales.reduce((sum, s) => sum + s.totalPrice, 0);
    const totalReturns = filteredData.returns.length;
    const totalQty = filteredData.sales.reduce((sum, s) => sum + s.quantitySold, 0);
    return { totalSales, totalReturns, totalQty };
  }, [filteredData]);

  const handlePrint = (sale: Sale) => {
    setPrintSale(sale);
    setTimeout(() => {
      window.print();
    }, 100);
  };

  if (salesLoading || returnsLoading) {
    return <PageSkeleton chart rows={6} />;
  }

  return (
    <>
      <div className="space-y-6">
        <DateRangePicker
          startDate={dateRange.start}
          endDate={dateRange.end}
          onRangeChange={(start, end) => setDateRange({ start, end })}
        />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            title={strings.totalSales}
            value={formatCurrency(stats.totalSales, locale)}
            icon={DollarSign}
            color="success"
          />
          <StatCard
            title={strings.totalQty}
            value={strings.qtySuffix.replace("{n}", String(stats.totalQty))}
            icon={ShoppingCart}
            color="accent"
          />
          <StatCard
            title={strings.totalReturns}
            value={stats.totalReturns}
            subtitle={strings.returnsSubtitle}
            icon={RotateCcw}
            color="danger"
          />
        </div>

        <div className="space-y-4">
          <h3 className="font-bold text-lg px-1">{strings.detailsHeading}</h3>

          {filteredData.sales.length === 0 ? (
            <EmptyState type="sales" />
          ) : (
            <>
              <div className="hidden md:block">
                <SalesTable
                  sales={filteredData.sales}
                  onReturn={() => {}}
                  onPrint={handlePrint}
                  onEdit={() => {}}
                  onVoid={() => {}}
                  selectedIds={new Set()}
                  onToggleSelect={() => {}}
                  onToggleSelectAll={() => {}}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:hidden">
                {filteredData.sales.map((sale) => (
                  <SaleCard
                    key={sale.id}
                    sale={sale}
                    onReturn={() => {}}
                    onPrint={handlePrint}
                    onEdit={() => {}}
                    onVoid={() => {}}
                    selected={false}
                    onToggleSelect={() => {}}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

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
    </>
  );
}
