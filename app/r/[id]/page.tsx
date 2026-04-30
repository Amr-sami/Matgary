"use client";

import { use, useEffect, useState } from "react";
import { Printer, Download } from "lucide-react";
import { Receipt } from "@/components/sales/Receipt";
import { getSaleById } from "@/lib/firestore";
import type { Sale } from "@/lib/types";

interface PageProps {
  params: Promise<{ id: string }>;
}

const PUBLIC_STORE = {
  name: "Corner Store",
  website: "https://cornerwatcesstore.com",
  phone: "01500228266",
};

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
        else {
          setSale(s);
          // Update tab title to the receipt # so customers don't see admin branding
          document.title = `فاتورة #${s.id.slice(-8).toUpperCase()} — ${PUBLIC_STORE.name}`;
        }
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
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-danger font-bold">{error || "غير موجود"}</p>
        <p className="text-sm text-text-secondary">
          من فضلك اطلب الرابط الصحيح من بائع {PUBLIC_STORE.name}.
        </p>
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
        {/* Customer-facing toolbar — no link back to the admin app */}
        <div className="flex items-center justify-end gap-2 mb-4 no-print">
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

        <div className="bg-white border border-border rounded-xl shadow-sm p-4">
          <div className="public-receipt-wrapper receipt-preview">
            <Receipt sale={receiptData} />
          </div>
        </div>

        <p className="text-center text-xs text-text-secondary mt-4 no-print">
          اضغط &quot;حفظ PDF&quot; ثم اختر &quot;Save as PDF&quot; من نافذة الطباعة
        </p>

        <div className="mt-6 text-center text-xs text-text-secondary no-print space-y-1">
          <p className="font-bold text-text-primary">{PUBLIC_STORE.name}</p>
          <p>
            للتواصل:{" "}
            <a
              href={`tel:${PUBLIC_STORE.phone}`}
              className="text-accent hover:underline"
            >
              {PUBLIC_STORE.phone}
            </a>
          </p>
          <p>
            <a
              href={PUBLIC_STORE.website}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              {PUBLIC_STORE.website.replace("https://", "")}
            </a>
          </p>
        </div>
      </div>

      {/* Hidden print container the global @media print rules target */}
      <div className="print-receipt-container" aria-hidden="true">
        <Receipt sale={receiptData} />
      </div>
    </div>
  );
}
