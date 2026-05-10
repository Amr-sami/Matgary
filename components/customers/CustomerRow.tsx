"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  Phone,
  Star,
  MessageCircle,
  Bell,
  Megaphone,
} from "@/lib/icons";
import { CATEGORY_LABELS } from "@/lib/types";
import { formatPrice, formatDate } from "@/lib/utils";
import {
  type CustomerAggregate,
  daysSince,
  topCategoryLabel,
} from "@/lib/customers";
import type { CustomerSaleRecord } from "@/hooks/useCustomersData";
import { useShopSettings } from "@/hooks/useShopSettings";

interface CustomerRowProps {
  customer: CustomerAggregate;
  records: CustomerSaleRecord[];
}

function waLink(phone: string | undefined, message: string): string {
  const cleaned = (phone || "").replace(/\D/g, "");
  return cleaned
    ? `https://wa.me/${cleaned}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export function CustomerRow({ customer, records }: CustomerRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isRepeat = customer.invoiceCount >= 3;
  const inactive = daysSince(customer.lastVisit) >= 60;
  // WhatsApp messages substitute the real shop name (was hardcoded
  // "Corner Store" pre-customer-ledger). Detail-page links only show for
  // customers we have a phone for — the ledger is keyed on phone.
  const { settings } = useShopSettings();
  const shopName = settings.shopName?.trim() || "متجرنا";
  const detailHref = customer.phone
    ? `/customers/${encodeURIComponent(customer.phone)}`
    : null;

  const invoices = useMemo(() => {
    if (!expanded) return [];
    const filtered = records.filter((s) => {
      if (s.isReturned) return false;
      const name = (s.customerName || "").trim();
      const phone = (s.customerPhone || "").trim();
      const key = phone || `name:${name.toLowerCase()}`;
      return key === customer.key;
    });
    // Group by invoiceId (fallback to sale id)
    const map = new Map<string, CustomerSaleRecord[]>();
    for (const s of filtered) {
      const id = s.invoiceId || s.id;
      const arr = map.get(id) || [];
      arr.push(s);
      map.set(id, arr);
    }
    return Array.from(map.entries())
      .map(([id, lines]) => ({
        id,
        lines,
        date: lines[0].saleDate,
        total: lines.reduce((s, l) => s + l.totalPrice, 0),
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [expanded, records, customer.key]);

  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      <div className="p-4 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-base truncate">{customer.name}</h3>
            {isRepeat && (
              <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-accent text-white font-medium">
                <Star className="w-3 h-3" />
                عميل دائم
              </span>
            )}
            {inactive && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                غير نشط ({daysSince(customer.lastVisit)} يوم)
              </span>
            )}
            {customer.outstandingBalance > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                آجل {formatPrice(customer.outstandingBalance)}
              </span>
            )}
          </div>
          {customer.phone && (
            <p className="text-xs text-text-secondary flex items-center gap-1 mt-1">
              <Phone className="w-3 h-3" />
              {customer.phone}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 text-end">
          <div>
            <p className="text-[10px] text-text-secondary">إجمالي الإنفاق</p>
            <p className="font-bold text-accent">{formatPrice(customer.lifetimeValue)}</p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary">فواتير</p>
            <p className="font-bold">{customer.invoiceCount}</p>
          </div>
        </div>
      </div>

      <div className="px-4 pb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-secondary">آخر زيارة: {formatDate(customer.lastVisit)}</span>
        {customer.topCategory && (
          <span className="px-2 py-0.5 rounded-full bg-gray-100 text-text-secondary">
            يفضّل: {topCategoryLabel(customer.topCategory)}
          </span>
        )}
      </div>

      <div className="border-t border-border bg-gray-50 px-4 py-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-border text-xs hover:border-accent"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {expanded ? "إخفاء" : "عرض الفواتير"}
        </button>

        <div className="flex-1" />

        {/* Detail-page link — primary CTA when there's debt to chase. */}
        {detailHref && (
          <Link
            href={detailHref}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              customer.outstandingBalance > 0
                ? "bg-accent text-white hover:bg-accent/90"
                : "bg-white border border-border text-text-secondary hover:border-accent hover:text-accent"
            }`}
          >
            {customer.outstandingBalance > 0 ? "إدارة الآجل" : "ملف العميل"}
            <ChevronLeft className="w-3.5 h-3.5" />
          </Link>
        )}

        {/* WhatsApp shortcuts — substitute the active branch's shop name. */}
        <a
          href={waLink(
            customer.phone,
            `أهلاً ${customer.name}! شكراً لتسوقك من ${shopName} ❤️ نتشرف بزيارتك مرة أخرى.`
          )}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-success-light text-success text-xs hover:bg-success hover:text-white"
          title="رسالة شكر"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          شكر
        </a>
        {customer.outstandingBalance > 0 && (
          <a
            href={waLink(
              customer.phone,
              `أهلاً ${customer.name}، تذكير ودي بمبلغ ${customer.outstandingBalance.toLocaleString("ar-EG")} ج.م الآجل عندك في ${shopName}. شكراً!`
            )}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-orange-100 text-orange-700 text-xs hover:bg-orange-500 hover:text-white"
            title="تذكير بالآجل"
          >
            <Bell className="w-3.5 h-3.5" />
            تذكير آجل
          </a>
        )}
        <a
          href={waLink(
            customer.phone,
            `${customer.name}! وصلتنا تشكيلة جديدة من ${
              customer.topCategory ? CATEGORY_LABELS[customer.topCategory] : "المنتجات"
            } في ${shopName}. تعالى شوفها 🌟`
          )}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent-light text-accent text-xs hover:bg-accent hover:text-white"
          title="عرض جديد"
        >
          <Megaphone className="w-3.5 h-3.5" />
          عرض جديد
        </a>
      </div>

      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {invoices.length === 0 && (
            <p className="p-4 text-sm text-text-secondary text-center">
              لا يوجد فواتير
            </p>
          )}
          {invoices.map((inv) => (
            <div key={inv.id} className="p-3 flex items-center justify-between flex-wrap gap-2">
              <div>
                <p className="text-xs text-text-secondary">
                  {formatDate(inv.date)} · {inv.lines.length} قطعة
                </p>
                <p className="text-sm">
                  {inv.lines.map((l) => l.productName).join("، ")}
                </p>
              </div>
              <p className="font-bold text-accent">{formatPrice(inv.total)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
