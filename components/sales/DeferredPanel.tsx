"use client";

import { useMemo, useState } from "react";
import { Wallet, Phone, CheckCircle2 } from "@/lib/icons";
import type { Sale } from "@/lib/types";
import { formatPrice, formatDate } from "@/lib/utils";
import { markInvoicePaid, markSalePaid } from "@/lib/api/sales";

interface DeferredPanelProps {
  sales: Sale[];
}

interface DeferredGroup {
  key: string;
  invoiceId: string | null;
  customerName?: string;
  customerPhone?: string;
  saleIds: string[];
  total: number;
  earliest: Date;
}

export function DeferredPanel({ sales }: DeferredPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, DeferredGroup>();
    for (const s of sales) {
      if (s.isReturned) continue;
      if (s.paymentMethod !== "deferred") continue;
      if (s.isPaid) continue;
      const key = s.invoiceId || s.id;
      const cur =
        map.get(key) || {
          key,
          invoiceId: s.invoiceId || null,
          customerName: s.customerName,
          customerPhone: s.customerPhone,
          saleIds: [],
          total: 0,
          earliest: s.saleDate,
        };
      cur.saleIds.push(s.id);
      cur.total += s.totalPrice;
      if (s.saleDate < cur.earliest) cur.earliest = s.saleDate;
      if (!cur.customerName && s.customerName) cur.customerName = s.customerName;
      if (!cur.customerPhone && s.customerPhone) cur.customerPhone = s.customerPhone;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort(
      (a, b) => a.earliest.getTime() - b.earliest.getTime()
    );
  }, [sales]);

  const totalOutstanding = groups.reduce((s, g) => s + g.total, 0);

  const handleMarkPaid = async (g: DeferredGroup) => {
    setBusy(g.key);
    try {
      if (g.invoiceId) {
        await markInvoicePaid(g.invoiceId);
      } else {
        for (const id of g.saleIds) await markSalePaid(id);
      }
    } catch (e) {
      console.warn("mark paid failed", e);
    } finally {
      setBusy(null);
    }
  };

  if (groups.length === 0) return null;

  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="w-5 h-5 text-orange-600" />
          <p className="font-bold">آجل غير مدفوع</p>
          <span className="text-xs px-2 py-0.5 rounded-full bg-orange-200 text-orange-900">
            {groups.length} عميل
          </span>
        </div>
        <p className="font-bold text-orange-700">{formatPrice(totalOutstanding)}</p>
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-orange-700 mt-2 hover:underline"
      >
        {expanded ? "إخفاء" : "عرض التفاصيل"}
      </button>

      {expanded && (
        <ul className="mt-3 space-y-2">
          {groups.map((g) => (
            <li
              key={g.key}
              className="flex flex-wrap items-center gap-2 p-3 rounded-lg bg-white border border-orange-100"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">
                  {g.customerName || "بدون اسم"}
                </p>
                <div className="flex flex-wrap gap-2 text-xs text-text-secondary mt-0.5">
                  {g.customerPhone && (
                    <span className="flex items-center gap-1">
                      <Phone className="w-3 h-3" />
                      {g.customerPhone}
                    </span>
                  )}
                  <span>{formatDate(g.earliest)}</span>
                  <span>
                    {g.saleIds.length === 1 ? "فاتورة واحدة" : `${g.saleIds.length} عناصر`}
                  </span>
                </div>
              </div>
              <span className="font-bold text-orange-700 whitespace-nowrap">
                {formatPrice(g.total)}
              </span>
              <button
                onClick={() => handleMarkPaid(g)}
                disabled={busy === g.key}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-success text-white text-xs font-medium hover:bg-success/90 disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                مدفوع
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
