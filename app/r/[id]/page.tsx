"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Printer, Download, ArrowLeft } from "lucide-react";
import { Receipt } from "@/components/sales/Receipt";
import { getSaleById } from "@/lib/firestore";
import type { Sale } from "@/lib/types";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function PublicReceiptPage({ params }: PageProps) {
  const { id } = use(params);
  const [sale, setSale] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getSaleById(id);
        if (cancelled) return;
        if (!s) setError("الفاتورة غير موجودة");
        else setSale(s);
      } catch {
        if (!cancelled) setError("تعذر تحميل الفاتورة");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handlePrint = () => window.print();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-text-secondary">
        جارٍ تحميل الفاتورة...
      </div>
    );
  }

  if (error || !sale) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-danger">{error || "غير موجود"}</p>
        <Link href="/" className="text-accent underline">العودة للرئيسية</Link>
      </div>
    );
  }

  const receiptData = {
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
  };

  return (
    <div className="public-receipt-page min-h-screen bg-bg-main py-6 px-4">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4 no-print">
          <Link
            href="/"
            className="text-text-secondary text-sm flex items-center gap-1 hover:text-accent"
          >
            <ArrowLeft className="w-4 h-4" />
            الرئيسية
          </Link>
          <div className="flex gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
            >
              <Download className="w-4 h-4" />
              حفظ PDF
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 bg-white border border-border px-4 py-2 rounded-lg text-sm font-medium hover:bg-bg-main"
            >
              <Printer className="w-4 h-4" />
              طباعة
            </button>
          </div>
        </div>

        <div className="bg-white border border-border rounded-xl shadow-sm p-4">
          <div className="public-receipt-wrapper receipt-preview">
            <Receipt sale={receiptData} />
          </div>
        </div>

        <p className="text-center text-xs text-text-secondary mt-4 no-print">
          اضغط &quot;حفظ PDF&quot; ثم اختر &quot;Save as PDF&quot; من نافذة الطباعة
        </p>
      </div>

      {/* Hidden print container the global @media print rules target */}
      <div className="print-receipt-container" aria-hidden="true">
        <Receipt sale={receiptData} />
      </div>
    </div>
  );
}
