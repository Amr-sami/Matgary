"use client";

import { useCallback, useEffect, useState } from "react";

export type PurchaseOrderStatus = "draft" | "received" | "cancelled";

export interface PurchaseOrderSummary {
  id: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  orderDate: Date;
  receivedDate: Date | null;
  notes: string | null;
  total: number;
  paidAmount: number;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ApiPurchaseOrder {
  id: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  receivedDate: string | null;
  notes: string | null;
  total: number;
  paidAmount: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

const fromApi = (po: ApiPurchaseOrder): PurchaseOrderSummary => ({
  ...po,
  orderDate: new Date(po.orderDate),
  receivedDate: po.receivedDate ? new Date(po.receivedDate) : null,
  createdAt: new Date(po.createdAt),
  updatedAt: new Date(po.updatedAt),
});

export function usePurchaseOrders(filters?: {
  supplierId?: string;
  status?: PurchaseOrderStatus;
}) {
  const [data, setData] = useState<PurchaseOrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supplierId = filters?.supplierId;
  const status = filters?.status;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (supplierId) params.set("supplierId", supplierId);
      if (status) params.set("status", status);
      const url = `/api/purchase-orders${params.size ? "?" + params.toString() : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 403) {
        setData([]);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: { data: ApiPurchaseOrder[] } = await res.json();
      setData(json.data.map(fromApi));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setLoading(false);
    }
  }, [supplierId, status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
