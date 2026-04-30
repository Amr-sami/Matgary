"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Independent data hook used ONLY by the customers page.
 *
 * It reads the raw `sales` collection directly and explicitly extracts
 * `customerName` / `customerPhone` / `paymentMethod` / `isPaid` fields,
 * bypassing the shared subscribeToSales chunk. This guards against any
 * scenario where a cached/older bundle of subscribeToSales is dropping
 * those fields.
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

function asDate(v: unknown): Date {
  if (v && typeof (v as Timestamp).toDate === "function") {
    return (v as Timestamp).toDate();
  }
  if (v instanceof Date) return v;
  return new Date();
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

export function useCustomersData() {
  const [records, setRecords] = useState<CustomerSaleRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "sales"), orderBy("saleDate", "desc"));
    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: false },
      (snap) => {
        const list: CustomerSaleRecord[] = snap.docs.map((d) => {
          const raw = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            invoiceId: asString(raw.invoiceId),
            productId: (raw.productId as string) || "",
            productName: (raw.productName as string) || "",
            category: (raw.category as string) || "",
            totalPrice: Number(raw.totalPrice ?? 0),
            saleDate: asDate(raw.saleDate),
            isReturned: !!raw.isReturned,
            customerName: asString(raw.customerName),
            customerPhone: asString(raw.customerPhone),
            paymentMethod: asString(raw.paymentMethod),
            isPaid:
              typeof raw.isPaid === "boolean"
                ? (raw.isPaid as boolean)
                : raw.paymentMethod !== "deferred",
          };
        });
        setRecords(list);
        setLoading(false);
      },
      (err) => {
        console.error("[useCustomersData] snapshot error", err);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  return { records, loading };
}
