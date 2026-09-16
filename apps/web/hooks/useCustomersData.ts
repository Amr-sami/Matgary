"use client";

import { useMemo } from "react";
import { useSales } from "./useSales";

/**
 * Customer-page projection of the sales list. After Wave 2, this hook
 * just wraps `useSales` so two co-mounted consumers share one network
 * request via TanStack Query's in-flight dedup.
 *
 * Previously this hook fetched /api/sales independently and reimplemented
 * its own visibilitychange/focus refetch loop. That's now centralised in
 * the QueryProvider (`refetchOnReconnect: true`) plus the regular
 * `staleTime: 0` on the sales query — invalidating on focus is a
 * one-line useEffect on the call site if a page truly needs it.
 */

export interface CustomerSaleRecord {
  id: string;
  invoiceId?: string;
  productId: string;
  productName: string;
  category: string;
  totalPrice: number;
  saleDate: Date;
  isReturned: boolean;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: string;
  isPaid?: boolean;
  amountPaid?: number;
}

export function useCustomersData() {
  // Customer page needs full history for receivables math — opt into
  // the unbounded read instead of the default 60-day window.
  const { sales, loading, refresh } = useSales({ all: true });

  const records = useMemo<CustomerSaleRecord[]>(
    () =>
      sales.map((s) => ({
        id: s.id,
        invoiceId: s.invoiceId,
        productId: s.productId,
        productName: s.productName,
        category: s.category,
        totalPrice: s.totalPrice,
        saleDate: s.saleDate,
        isReturned: s.isReturned,
        customerName: s.customerName,
        customerPhone: s.customerPhone,
        paymentMethod: s.paymentMethod,
        isPaid: s.isPaid,
        amountPaid: s.amountPaid,
      })),
    [sales],
  );

  return { records, loading, refresh };
}
