"use client";

import { useEffect, useState } from "react";
import { listSales } from "@/lib/api/sales";

/**
 * Independent data hook used by the customers page.
 *
 * Reads sales via the standard /api/sales endpoint and projects them down to
 * the subset the customers page cares about. Mirrors the original interface
 * the Firebase-backed version exposed.
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
}

export function useCustomersData() {
  const [records, setRecords] = useState<CustomerSaleRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sales = await listSales();
        if (cancelled) return;
        setRecords(
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
          })),
        );
      } catch (err) {
        console.error("[useCustomersData] failed to load sales", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { records, loading };
}
