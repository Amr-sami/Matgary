"use client";

import { useEffect, useState } from "react";
import {
  MessageCircle,
  Save,
  Phone,
  Store,
  Cloud,
  Eye,
  Info,
} from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast } from "@/components/ui/Toast";
import { useShopSettings } from "@/hooks/useShopSettings";
import {
  DEFAULT_TEMPLATE,
  saveSettings,
  substitute,
  type ShopSettings,
} from "@/lib/settings";
import { formatPrice } from "@/lib/utils";

const PLACEHOLDERS: { key: string; description: string }[] = [
  { key: "customerName", description: "اسم العميل" },
  { key: "customerPhone", description: "رقم العميل" },
  { key: "invoiceId", description: "رقم الفاتورة الكامل" },
  { key: "invoiceCode", description: "آخر 8 أحرف من رقم الفاتورة" },
  { key: "totalPrice", description: "إجمالي الفاتورة" },
  { key: "productNames", description: "أسماء المنتجات (مفصولة بفاصلة)" },
  { key: "receiptLink", description: "رابط الفاتورة" },
  { key: "date", description: "تاريخ البيع" },
  { key: "shopName", description: "اسم المتجر" },
  { key: "shopPhone", description: "رقم المتجر" },
];

export default function SettingsPage() {
  const { settings, loading } = useShopSettings();
  const [draft, setDraft] = useState<ShopSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Sync draft when remote settings load
  useEffect(() => {
    if (!loading) setDraft(settings);
  }, [loading, settings]);

  const update = <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setBusy(true);
    try {
      await saveSettings(draft);
      setToast({ type: "success", message: "تم حفظ الإعدادات" });
    } catch (e: any) {
      setToast({ type: "error", message: e.message || "تعذر الحفظ" });
    } finally {
      setBusy(false);
    }
  };

  const handleResetTemplate = () => {
    update("messageTemplate", DEFAULT_TEMPLATE);
  };

  const handleInsertPlaceholder = (key: string) => {
    update("messageTemplate", `${draft.messageTemplate}{${key}}`);
  };

  // Live preview using sample data
  const previewMessage = substitute(draft.messageTemplate, {
    customerName: "عمرو سامي",
    customerPhone: "01552190743",
    invoiceId: "INV-MOLI6XQ7ZL8YKA",
    invoiceCode: "L6XQ7ZL8",
    totalPrice: formatPrice(2500),
    productNames: "ساعة Naviforce, نظارة Ray-Ban",
    receiptLink: "https://cornerstore-five.vercel.app/r/abc123",
    date: new Date().toLocaleDateString("ar-EG"),
    shopName: draft.shopName,
    shopPhone: draft.shopPhone,
  });

  if (loading) {
    return (
      <AppShell title="الإعدادات">
        <div className="text-center py-20 text-text-secondary">
          جارٍ التحميل...
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="الإعدادات">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* WhatsApp section */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-success" />
            <h3 className="font-bold text-lg">إعدادات واتساب</h3>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
            <input
              type="checkbox"
              checked={draft.autoOpenWhatsApp}
              onChange={(e) => update("autoOpenWhatsApp", e.target.checked)}
              className="mt-1 w-5 h-5 accent-accent"
            />
            <div className="flex-1">
              <p className="font-medium">إرسال الفاتورة تلقائياً عبر واتساب</p>
              <p className="text-xs text-text-secondary mt-0.5">
                عند تسجيل بيع جديد لعميل عنده رقم موبايل، البرنامج يفتح
                واتساب فيه الفاتورة + رسالة شكر جاهزة. تحتاج تضغط "إرسال" فقط.
              </p>
            </div>
          </label>

          <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs space-y-1">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">
                  الإرسال التلقائي 100% (بدون ضغط زر)
                </p>
                <p className="text-text-secondary leading-relaxed">
                  يحتاج تفعيل WhatsApp Cloud API من Meta Business و عمل تحقق
                  للحساب. لما تجهز الحساب وتدّيني الـ access token + رقم
                  الواتساب اللي اتعمله verify، نقدر نوصّل API الكامل.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 mt-2 opacity-50 cursor-not-allowed">
              <input
                type="checkbox"
                checked={draft.cloudApiEnabled}
                disabled
                className="w-4 h-4 accent-accent"
              />
              <span>تفعيل WhatsApp Cloud API (يحتاج إعداد لاحق)</span>
            </label>
          </div>
        </div>

        {/* Shop info */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Store className="w-5 h-5 text-accent" />
            <h3 className="font-bold text-lg">معلومات المتجر</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="اسم المتجر"
              value={draft.shopName}
              onChange={(e) => update("shopName", e.target.value)}
            />
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                رقم واتساب المتجر
              </label>
              <div className="relative">
                <Phone className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
                <input
                  type="tel"
                  inputMode="tel"
                  value={draft.shopPhone}
                  onChange={(e) => update("shopPhone", e.target.value)}
                  dir="ltr"
                  placeholder="01500228266"
                  className="w-full ps-10 pe-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <p className="text-[10px] text-text-secondary mt-1">
                يُستخدم في توقيع الرسالة وفي رابط tel: على فواتير العملاء.
              </p>
            </div>
          </div>
        </div>

        {/* Template */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-lg">قالب الرسالة</h3>
            </div>
            <button
              onClick={handleResetTemplate}
              className="text-xs text-text-secondary hover:text-accent"
            >
              استعادة الافتراضي
            </button>
          </div>

          <textarea
            value={draft.messageTemplate}
            onChange={(e) => update("messageTemplate", e.target.value)}
            dir="rtl"
            rows={10}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />

          <div>
            <p className="text-xs text-text-secondary mb-2">
              المتغيرات المتاحة (اضغط لإضافتها للنص):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDERS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => handleInsertPlaceholder(p.key)}
                  className="text-[11px] px-2 py-1 rounded-md bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors"
                  title={p.description}
                >
                  {`{${p.key}}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-text-secondary mb-1.5">
              معاينة (مع بيانات تجريبية):
            </p>
            <div
              dir="rtl"
              className="whitespace-pre-wrap rounded-lg border border-border bg-bg-main p-3 text-sm leading-relaxed font-mono"
            >
              {previewMessage}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} loading={busy} className="flex items-center gap-2">
            <Save className="w-4 h-4" />
            حفظ الإعدادات
          </Button>
        </div>
      </div>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
