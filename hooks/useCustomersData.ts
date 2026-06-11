"use client";

import { useCallback, useEffect, useState } from "react";
import { listSales } from "@/lib/api/sales";

/**
 * Independent data hook used by the customers page.
 *
 * Reads sales via the standard /api/sales endpoint and projects them down
 * to the subset the customers page cares about.
 *
 * Refresh triggers:
 *   - Mount (initial load — shows skeleton).
 *   - Tab focus / visibility change — covers "user opened the customer
 *     detail page in a new tab, marked an invoice paid, came back to this
 *     tab" where the list would otherwise show stale outstanding totals.
 *   - The exposed `refresh()` function — for explicit re-fetches after a
 *     mutation in the same page (e.g. when we add inline actions).
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
  /** Partial-payments tracking. Defaults to 0 on legacy rows; the
   *  receivables aggregator falls back to the isPaid heuristic when this
   *  is missing. */
  amountPaid?: number;
}

export function useCustomersData() {
  const [records, setRecords] = useState<CustomerSaleRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const sales = await listSales();
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
          amountPaid: s.amountPaid,
        })),
      );
    } catch (err) {
      console.error("[useCustomersData] failed to load sales", err);
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);

    // Silent re-fetch on focus / visibility — don't flip `loading` so the
    // list doesn't blink back to a skeleton every time the user tabs away
    // and comes back. Same handler ref for both events so we can detach
    // them cleanly.
    const onWake = () => {
      if (
        typeof document === "undefined" ||
        document.visibilityState === "visible"
      ) {
        void refresh(false);
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [refresh]);

  return { records, loading, refresh };
}
