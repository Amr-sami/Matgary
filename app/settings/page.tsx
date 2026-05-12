"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  MessageCircle,
  Save,
  Phone,
  Store,
  Eye,
  Info,
  Zap,
  Send,
  ExternalLink,
  ChevronLeft,
} from "@/lib/icons";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast } from "@/components/ui/Toast";
import { useShopSettings } from "@/hooks/useShopSettings";
import { useSettings } from "@/components/settings-context";
import { useBranches } from "@/hooks/useBranches";
import {
  DEFAULT_TEMPLATE,
  saveSettings,
  substitute,
  type ShopSettings,
} from "@/lib/settings";
import { sendViaGreenApi, sendViaWhatsAppCloud } from "@/lib/whatsapp";
import { formatPrice } from "@/lib/utils";
import { CategoriesEditor } from "@/components/settings/CategoriesEditor";
import { BrandsEditor } from "@/components/settings/BrandsEditor";

// Shape mirrored from /api/whatsapp/connection. Kept local so changes to
// the API shape force an update here too (no shared type drift).
interface WaConnectionView {
  id: string;
  provider: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: "active" | "disconnected" | "expired" | "revoked" | "error";
  mode: "sandbox" | "live";
  webhookSubscribed: boolean;
  scopes: string[];
  tokenType: string;
  tokenExpiresAt: string | null;
  connectedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  tokenLastValidatedAt: string | null;
  lastGraphHealthcheckAt: string | null;
  connectionErrorState:
    | "ok"
    | "token_expired"
    | "token_revoked"
    | "scope_missing"
    | "waba_inaccessible"
    | "phone_unverified"
    | "network"
    | "unknown"
    | null;
}

interface WaTemplateView {
  id: string;
  name: string;
  language: string;
  category: "authentication" | "utility" | "marketing" | "unknown";
  status:
    | "approved"
    | "pending"
    | "rejected"
    | "paused"
    | "in_appeal"
    | "pending_deletion"
    | "disabled"
    | "flagged"
    | "stale"
    | "unknown";
  rejectedReason: string | null;
  lastSyncedAt: string;
}

// Map machine error states to actionable Arabic copy. Anything not listed
// here falls back to the raw `note` from the health endpoint, so adding a
// new state code in lib/whatsapp/health.ts doesn't break the UI.
const ERROR_STATE_COPY: Record<string, { title: string; cta: "reconnect" | "verify" | "retry" }> = {
  token_expired: {
    title: "انتهت صلاحية التوكن. اضغط إعادة الربط لإصدار توكن جديد.",
    cta: "reconnect",
  },
  token_revoked: {
    title: "تم إبطال التوكن من Meta. اضغط إعادة الربط لإعادة المصادقة.",
    cta: "reconnect",
  },
  scope_missing: {
    title: "صلاحيات ناقصة على التوكن. اعد الربط ووافق على جميع الصلاحيات.",
    cta: "reconnect",
  },
  phone_unverified: {
    title: "الرقم غير موثّق على Meta. أكمل التحقق من Business Manager.",
    cta: "verify",
  },
  waba_inaccessible: {
    title: "تعذر الوصول لحساب WhatsApp Business. تحقق من الإذن أو أعد الربط.",
    cta: "reconnect",
  },
  network: {
    title: "تعذر الاتصال بـ Meta مؤقتاً. أعد المحاولة بعد لحظات.",
    cta: "retry",
  },
};

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

// Cheap field-by-field equality so the Save button can flip to disabled the
// moment the form matches the saved server state again.
function isEqualSettings(a: ShopSettings, b: ShopSettings): boolean {
  return (
    a.shopName === b.shopName &&
    a.shopPhone === b.shopPhone &&
    a.autoOpenWhatsApp === b.autoOpenWhatsApp &&
    a.messageTemplate === b.messageTemplate &&
    a.greenApiEnabled === b.greenApiEnabled &&
    a.greenApiInstanceId === b.greenApiInstanceId &&
    a.greenApiToken === b.greenApiToken &&
    a.greenApiUrl === b.greenApiUrl &&
    a.whatsappCloudEnabled === b.whatsappCloudEnabled &&
    a.whatsappCloudPhoneId === b.whatsappCloudPhoneId &&
    a.whatsappCloudToken === b.whatsappCloudToken &&
    a.whatsappCloudBusinessId === b.whatsappCloudBusinessId &&
    a.sendAsPdf === b.sendAsPdf &&
    a.loyaltyEnabled === b.loyaltyEnabled &&
    a.loyaltyPointsPerEgp === b.loyaltyPointsPerEgp &&
    a.loyaltyEgpPerPoint === b.loyaltyEgpPerPoint &&
    a.receiptLogoSize === b.receiptLogoSize &&
    a.receiptFooterText === b.receiptFooterText &&
    a.receiptLanguage === b.receiptLanguage &&
    a.receiptShowLoyalty === b.receiptShowLoyalty
  );
}

const LOGO_SIZE_OPTIONS: { value: ShopSettings["receiptLogoSize"]; label: string }[] = [
  { value: "hidden", label: "بدون شعار" },
  { value: "small", label: "صغير" },
  { value: "medium", label: "متوسط (افتراضي)" },
  { value: "large", label: "كبير" },
];

const LANGUAGE_OPTIONS: { value: ShopSettings["receiptLanguage"]; label: string; hint: string }[] = [
  { value: "ar", label: "العربية", hint: "الإجمالي، الخصم، شكراً..." },
  { value: "en", label: "English", hint: "TOTAL, DISCOUNT, THANK YOU..." },
  { value: "bilingual", label: "ثنائي اللغة", hint: "TOTAL · الإجمالي" },
];

export default function SettingsPage() {
  const { data: session } = useSession();
  const isOwner = session?.user?.role === "owner";
  const { branches: accessibleBranches } = useBranches();
  const branchCount = accessibleBranches.length;
  const { settings, loading, refresh: refreshLocalSettings } = useShopSettings();
  const { refresh: refreshGlobalSettings } = useSettings();
  const [draft, setDraft] = useState<ShopSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [cloudTesting, setCloudTesting] = useState(false);
  const [cloudTestPhone, setCloudTestPhone] = useState("");
  const [toast, setToast] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Embedded Signup connection state — separate from shop_settings.
  const [connection, setConnection] = useState<WaConnectionView | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [showManualCloudFields, setShowManualCloudFields] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Templates — cached Meta message-template library for this branch.
  const [templates, setTemplates] = useState<WaTemplateView[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesSyncing, setTemplatesSyncing] = useState(false);
  const refreshTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const res = await fetch("/api/whatsapp/templates", { cache: "no-store" });
      if (!res.ok) {
        setTemplates([]);
        return;
      }
      const json = (await res.json()) as { templates?: WaTemplateView[] };
      setTemplates(json.templates ?? []);
    } catch {
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  };
  const handleSyncTemplates = async () => {
    setTemplatesSyncing(true);
    try {
      const res = await fetch("/api/whatsapp/templates/sync", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setToast({
          type: "success",
          message: `تم تحديث القوالب — ${json.upserted ?? 0} قالب${
            (json.fetched ?? 0) > 0 ? ` من ${json.fetched}` : ""
          }`,
        });
        await refreshTemplates();
      } else {
        setToast({
          type: "error",
          message: json?.reason || json?.error || `HTTP ${res.status}`,
        });
      }
    } finally {
      setTemplatesSyncing(false);
    }
  };
  const router = useRouter();
  const searchParams = useSearchParams();

  // Refresh connection status from /api/whatsapp/connection.
  const refreshConnection = async () => {
    try {
      const res = await fetch("/api/whatsapp/connection", { cache: "no-store" });
      if (!res.ok) {
        setConnection(null);
        return;
      }
      const json = (await res.json()) as { connected: boolean; connection: WaConnectionView | null };
      setConnection(json.connection);
    } catch {
      setConnection(null);
    } finally {
      setConnectionLoading(false);
    }
  };

  useEffect(() => {
    refreshConnection();
    refreshTemplates();
  }, []);

  // Pick up the OAuth callback flash and surface it as a toast.
  useEffect(() => {
    const wa = searchParams.get("wa");
    if (!wa) return;
    const detail = searchParams.get("wa_detail") || undefined;
    if (wa === "ok") {
      setToast({
        type: "success",
        message: detail
          ? `تم ربط واتساب — ${detail}`
          : "تم ربط حساب واتساب بنجاح",
      });
      refreshConnection();
    } else {
      setToast({
        type: "error",
        message: detail || "تعذر إكمال ربط واتساب",
      });
    }
    // Strip the flash params so a refresh doesn't re-fire the toast.
    router.replace("/settings");
  }, [searchParams, router]);

  const handleConnect = () => {
    // Full navigation — the OAuth start route 302s to Meta. Using an
    // anchor would also work, but window.location.href keeps the rest of
    // the page's state in case the user backs out of Meta's popup.
    window.location.href = "/api/whatsapp/oauth/start";
  };

  const [healthChecking, setHealthChecking] = useState(false);
  const handleHealthCheck = async () => {
    setHealthChecking(true);
    try {
      const res = await fetch("/api/whatsapp/connection/healthcheck", {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setToast({
          type: json.ok ? "success" : "error",
          message: json.note || (json.ok ? "الاتصال سليم" : "تعذر التحقق"),
        });
        await refreshConnection();
      } else {
        setToast({
          type: "error",
          message: json?.error || `HTTP ${res.status}`,
        });
      }
    } finally {
      setHealthChecking(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("تأكيد فصل ربط واتساب؟ يمكنك الربط مرة أخرى لاحقاً.")) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/whatsapp/oauth/disconnect", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.ok) {
        setToast({ type: "success", message: "تم فصل الربط" });
        await refreshConnection();
      } else {
        setToast({ type: "error", message: json?.error || "تعذر فصل الربط" });
      }
    } finally {
      setDisconnecting(false);
    }
  };

  // Sync draft when remote settings load
  useEffect(() => {
    if (!loading) setDraft(settings);
  }, [loading, settings]);

  const update = <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = !isEqualSettings(draft, settings);

  const handleSave = async () => {
    if (!dirty) return;
    setBusy(true);
    try {
      await saveSettings(draft);
      // Re-fetch BOTH:
      //  - the local hook that drives this page's `settings` baseline, so the
      //    Save button correctly returns to its disabled "no changes" state;
      //  - the global SettingsProvider context so the sidebar (and anything
      //    else reading shopName) re-renders without a page reload.
      await Promise.all([refreshLocalSettings(), refreshGlobalSettings()]);
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

  const handleTestSend = async () => {
    if (!testPhone.trim()) {
      setToast({ type: "error", message: "أدخل رقم للاختبار" });
      return;
    }
    if (!draft.greenApiInstanceId.trim() || !draft.greenApiToken.trim()) {
      setToast({ type: "error", message: "أدخل instanceId و apiToken أولاً" });
      return;
    }
    setTesting(true);
    try {
      // Server-side credential lookup — no need to pass instanceId/token from
      // the client anymore (the operator must save first to populate them).
      const res = await sendViaGreenApi({
        phone: testPhone.trim(),
        message: `🧪 رسالة اختبار من ${draft.shopName}\nالتاريخ: ${new Date().toLocaleString("ar-EG")}`,
      });
      if (res.ok) {
        setToast({
          type: "success",
          message: `تم الإرسال (id: ${res.idMessage || "—"})`,
        });
      } else {
        setToast({
          type: "error",
          message: res.error || "تعذر الإرسال",
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleCloudTestSend = async () => {
    if (!cloudTestPhone.trim()) {
      setToast({ type: "error", message: "أدخل رقم للاختبار" });
      return;
    }
    if (!draft.whatsappCloudPhoneId.trim() || !draft.whatsappCloudToken.trim()) {
      setToast({ type: "error", message: "أدخل Phone Number ID والتوكن أولاً" });
      return;
    }
    setCloudTesting(true);
    try {
      const res = await sendViaWhatsAppCloud({
        phone: cloudTestPhone.trim(),
        message: `🧪 رسالة اختبار من ${draft.shopName}\nالتاريخ: ${new Date().toLocaleString("ar-EG")}`,
      });
      if (res.ok) {
        setToast({
          type: "success",
          message: `تم الإرسال (id: ${res.idMessage || "—"})`,
        });
      } else {
        setToast({
          type: "error",
          message: res.error || "تعذر الإرسال",
        });
      }
    } finally {
      setCloudTesting(false);
    }
  };

  // Live preview using sample data
  const previewMessage = substitute(draft.messageTemplate, {
    customerName: "عمرو سامي",
    customerPhone: "01552190743",
    invoiceId: "INV-MOLI6XQ7ZL8YKA",
    invoiceCode: "L6XQ7ZL8",
    totalPrice: formatPrice(2500),
    productNames: "ساعة Naviforce, نظارة Ray-Ban",
    receiptLink: "",
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
        {/* Branches — owner-only entry point. Hides for staff (they can't
            manage branches) but stays visible for single-store owners so the
            multi-branch feature is discoverable. */}
        {isOwner && (
          <Link
            href="/settings/branches"
            className="group block bg-white rounded-xl border border-border p-5 hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-accent-light text-accent flex items-center justify-center">
                <Store className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-text-primary">إدارة الفروع</h3>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-bg-main text-text-secondary tabular-nums">
                    {branchCount} {branchCount === 1 ? "فرع" : "فروع"}
                  </span>
                </div>
                <p className="text-xs text-text-secondary mt-0.5">
                  {branchCount <= 1
                    ? "أضف فرعاً جديداً لتتبع المبيعات والمخزون لكل موقع على حدة."
                    : "إدارة الفروع، تعطيل أو حذف فرع، وتعديل بيانات الموقع."}
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
            </div>
          </Link>
        )}

        <CategoriesEditor onToast={setToast} />
        <BrandsEditor onToast={setToast} />

        {/* Loyalty programme — per-branch. Owner-only edits would be nice
            but for v1 anyone with view_settings can change rates. */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-bold text-lg">برنامج الولاء</h3>
              <p className="text-xs text-text-secondary mt-0.5">
                نقاط ورصيد العميل — كل فرع له برنامجه المستقل.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={draft.loyaltyEnabled}
                onChange={(e) => update("loyaltyEnabled", e.target.checked)}
                className="w-5 h-5 accent-accent"
              />
              <span className="text-sm font-medium">
                {draft.loyaltyEnabled ? "مفعّل" : "غير مفعّل"}
              </span>
            </label>
          </div>

          {draft.loyaltyEnabled && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input
                  label="نقاط لكل ج.م مصروف"
                  type="number"
                  step="0.01"
                  min="0"
                  value={String(draft.loyaltyPointsPerEgp)}
                  onChange={(e) =>
                    update("loyaltyPointsPerEgp", Number(e.target.value) || 0)
                  }
                  placeholder="مثال: 0.1 = نقطة لكل 10 ج.م"
                />
                <Input
                  label="قيمة النقطة الواحدة (ج.م)"
                  type="number"
                  step="0.01"
                  min="0"
                  value={String(draft.loyaltyEgpPerPoint)}
                  onChange={(e) =>
                    update("loyaltyEgpPerPoint", Number(e.target.value) || 0)
                  }
                  placeholder="مثال: 0.1 = نقطة بـ 10 قروش"
                />
              </div>

              {/* Live example so the owner sees what the rates mean. */}
              <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs text-text-secondary leading-relaxed">
                <p className="font-medium text-text-primary mb-1">مثال:</p>
                {(() => {
                  const earned = Math.floor(100 * draft.loyaltyPointsPerEgp);
                  const value = (
                    earned * draft.loyaltyEgpPerPoint
                  ).toFixed(2);
                  return (
                    <>
                      <p>
                        فاتورة بـ <b>100 ج.م</b> تكسب{" "}
                        <b className="text-accent">{earned}</b> نقطة قيمتها{" "}
                        <b className="text-accent">{value} ج.م</b> خصم على
                        فاتورة قادمة.
                      </p>
                      {draft.loyaltyPointsPerEgp === 0 &&
                        draft.loyaltyEgpPerPoint === 0 && (
                          <p className="mt-1 text-orange-600">
                            ⚠ النقاط لن تُكتسب أو تُخصم حتى تحدد أحد المعدلين.
                          </p>
                        )}
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>

        {/* Receipt customisation — per-branch. Logo size, footer copy,
            language, and loyalty visibility on the printed receipt. */}
        <ReceiptCustomisationCard draft={draft} update={update} />

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

        </div>

        {/* Green API */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-success" />
            <h3 className="font-bold text-lg">Green API — إرسال تلقائي بالكامل</h3>
          </div>

          <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs space-y-1.5">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <p className="font-medium">خطوات التفعيل:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-text-secondary">
                  <li>
                    افتح حساب على{" "}
                    <a
                      href="https://green-api.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      green-api.com <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    أنشئ <code className="bg-white px-1 rounded">Instance</code> جديد
                  </li>
                  <li>
                    من شاشة الـ Instance، انسخ{" "}
                    <code className="bg-white px-1 rounded">idInstance</code> و{" "}
                    <code className="bg-white px-1 rounded">apiTokenInstance</code>{" "}
                    والصقهم في الخانات تحت
                  </li>
                  <li>
                    اسكان الـ QR من واتساب موبايل المتجر مرة واحدة لربط الحساب
                  </li>
                  <li>
                    فعّل الخيار وضغط "حفظ الإعدادات"، ثم جرب الإرسال من
                    خانة الاختبار
                  </li>
                </ol>
                <p className="text-orange-700 leading-relaxed">
                  <strong>تنبيه:</strong> Green API بتستخدم بروتوكول واتساب ويب
                  غير الرسمي. الاستخدام العادي للمتجر آمن، لكن الإرسال الكتلي
                  أو مكرّر بسرعة ممكن يعرّض الرقم للحظر.
                </p>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
            <input
              type="checkbox"
              checked={draft.greenApiEnabled}
              onChange={(e) => update("greenApiEnabled", e.target.checked)}
              className="mt-1 w-5 h-5 accent-accent"
            />
            <div className="flex-1">
              <p className="font-medium">تفعيل الإرسال التلقائي عبر Green API</p>
              <p className="text-xs text-text-secondary mt-0.5">
                لو مفعّل، الفاتورة تُرسل في الخلفية بدون ما يفتح أي تاب.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
            <input
              type="checkbox"
              checked={draft.sendAsPdf}
              onChange={(e) => update("sendAsPdf", e.target.checked)}
              disabled={!draft.greenApiEnabled}
              className="mt-1 w-5 h-5 accent-accent"
            />
            <div className="flex-1">
              <p className="font-medium">إرسال الفاتورة كملف PDF بدلاً من رابط</p>
              <p className="text-xs text-text-secondary mt-0.5">
                لو مفعّل، العميل بياخد الفاتورة كملف PDF مرفق في الواتساب
                (مع نص الرسالة كـ caption). أنظف وأكثر احترافاً من الرابط.
                يحتاج Green API مفعّل.
              </p>
            </div>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="idInstance"
              value={draft.greenApiInstanceId}
              onChange={(e) => update("greenApiInstanceId", e.target.value)}
              placeholder="7107606136"
            />
            <Input
              label="apiTokenInstance"
              value={draft.greenApiToken}
              onChange={(e) => update("greenApiToken", e.target.value)}
              type="password"
              placeholder="••••••••••••••••"
            />
          </div>
          <Input
            label="apiUrl (اختياري — من شاشة Green API)"
            value={draft.greenApiUrl}
            onChange={(e) => update("greenApiUrl", e.target.value)}
            placeholder="https://7107.api.greenapi.com"
          />

          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">
              <Send className="w-4 h-4 text-accent" />
              اختبار الإرسال
            </p>
            <div className="flex gap-2">
              <input
                type="tel"
                inputMode="tel"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="01000000000"
                dir="ltr"
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-white text-sm"
              />
              <Button
                onClick={handleTestSend}
                loading={testing}
                disabled={!draft.greenApiInstanceId || !draft.greenApiToken}
                className="whitespace-nowrap"
              >
                إرسال تجريبي
              </Button>
            </div>
            <p className="text-[10px] text-text-secondary">
              سيُرسل رسالة قصيرة "🧪 رسالة اختبار" للتأكد من ربط الحساب.
              تأكد من حفظ الإعدادات بعد الاختبار الناجح.
            </p>
          </div>
        </div>

        {/* WhatsApp Business Cloud API (Meta — official) */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-accent" />
            <h3 className="font-bold text-lg">
              WhatsApp Cloud API — القناة الرسمية من Meta
            </h3>
          </div>

          {/* Connection status — primary path. Embedded Signup writes
              wa_connections and we render the live state here. */}
          {connectionLoading ? (
            <div className="rounded-lg border border-border p-3 text-xs text-text-secondary">
              جارٍ التحقق من حالة الربط...
            </div>
          ) : connection && connection.status === "active" ? (
            <div className="rounded-lg border border-success/40 bg-success/5 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-medium text-sm flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-success" />
                    حساب واتساب مربوط
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {connection.verifiedName || "—"}{" "}
                    {connection.displayPhoneNumber && (
                      <>
                        ·{" "}
                        <span dir="ltr" className="font-mono">
                          {connection.displayPhoneNumber}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full ${
                      connection.mode === "live"
                        ? "bg-success/15 text-success"
                        : "bg-orange-100 text-orange-700"
                    }`}
                  >
                    {connection.mode === "live" ? "إنتاج" : "اختبار (sandbox)"}
                  </span>
                  {!connection.webhookSubscribed && (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700"
                      title="لم يتم تفعيل اشتراك الويبهوك بعد"
                    >
                      webhook معلّق
                    </span>
                  )}
                </div>
              </div>
              <div className="text-[11px] text-text-secondary space-y-0.5">
                <div>
                  WABA: <span dir="ltr" className="font-mono">{connection.wabaId}</span>
                </div>
                <div>
                  Phone ID:{" "}
                  <span dir="ltr" className="font-mono">{connection.phoneNumberId}</span>
                </div>
                <div>
                  تم الربط:{" "}
                  {new Date(connection.connectedAt).toLocaleString("ar-EG")}
                </div>
              </div>
              {/* Health-state banner — only shows when the last health
                  check flagged a problem. ERROR_STATE_COPY decides the
                  CTA; anything not mapped falls back to lastError. */}
              {connection.connectionErrorState &&
                connection.connectionErrorState !== "ok" && (
                  <div className="rounded-md border border-orange-300 bg-orange-50 p-2 text-xs space-y-1">
                    <p className="font-medium text-orange-800">
                      {ERROR_STATE_COPY[connection.connectionErrorState]
                        ?.title ||
                        connection.lastError ||
                        "تنبيه على الاتصال — راجع التفاصيل."}
                    </p>
                    {(() => {
                      const cta =
                        ERROR_STATE_COPY[connection.connectionErrorState]?.cta;
                      if (cta === "reconnect") {
                        return (
                          <Button
                            onClick={handleConnect}
                            className="!py-1 !text-[11px]"
                            variant="secondary"
                          >
                            إعادة الربط الآن
                          </Button>
                        );
                      }
                      if (cta === "retry") {
                        return (
                          <Button
                            onClick={handleHealthCheck}
                            loading={healthChecking}
                            className="!py-1 !text-[11px]"
                            variant="secondary"
                          >
                            إعادة المحاولة
                          </Button>
                        );
                      }
                      return null;
                    })()}
                  </div>
                )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  onClick={handleHealthCheck}
                  loading={healthChecking}
                  className="!py-1.5 !text-xs"
                  variant="secondary"
                >
                  فحص الاتصال
                </Button>
                <Button
                  onClick={handleConnect}
                  className="!py-1.5 !text-xs"
                  variant="secondary"
                >
                  إعادة الربط
                </Button>
                <Button
                  onClick={handleDisconnect}
                  loading={disconnecting}
                  variant="ghost"
                  className="!py-1.5 !text-xs text-error"
                >
                  فصل الربط
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-4 space-y-2">
              <p className="font-medium text-sm">لم يتم ربط حساب واتساب بعد</p>
              <p className="text-xs text-text-secondary leading-relaxed">
                اضغط "ربط حساب واتساب" لفتح Meta Embedded Signup. ستختار
                حساب WhatsApp Business، تضيف/تتحقق من رقم، وتعتمد الصلاحيات،
                وسنحفظ التوكن مشفّر تلقائياً — بدون نسخ يدوي.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleConnect} className="!py-2">
                  ربط حساب واتساب
                </Button>
                <button
                  type="button"
                  onClick={() => setShowManualCloudFields((v) => !v)}
                  className="text-xs text-text-secondary hover:text-accent underline underline-offset-4"
                >
                  {showManualCloudFields
                    ? "إخفاء الضبط اليدوي"
                    : "أو ضبط يدوي للتوكن (مؤقت)"}
                </button>
              </div>
              {connection?.lastError && (
                <p className="text-[11px] text-error">
                  آخر خطأ: {connection.lastError}
                </p>
              )}
            </div>
          )}

          {/* Manual cloud-API fields — fallback for tenants not yet on
              Embedded Signup. Hidden once an active connection exists, or
              until the operator explicitly opts in via the toggle. We also
              show them automatically when there's already a manual config
              saved, so we don't strand legacy setups. */}
          {(showManualCloudFields ||
            (!connection &&
              (draft.whatsappCloudPhoneId || draft.whatsappCloudToken))) && (
          <>
          <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs space-y-1.5">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <p className="font-medium">خطوات التفعيل:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-text-secondary">
                  <li>
                    افتح حساب على{" "}
                    <a
                      href="https://business.facebook.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      Meta Business Manager{" "}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {" "}وأنشئ <b>WhatsApp Business Account</b> (WABA)
                  </li>
                  <li>
                    من{" "}
                    <a
                      href="https://developers.facebook.com/apps"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      Meta for Developers{" "}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {" "}أنشئ App من نوع <code className="bg-white px-1 rounded">Business</code> وأضف منتج <code className="bg-white px-1 rounded">WhatsApp</code>
                  </li>
                  <li>
                    من شاشة WhatsApp {`>`} API Setup، اربط رقم المتجر
                    (Add phone number) ووثّقه عبر SMS/مكالمة
                  </li>
                  <li>
                    انسخ <code className="bg-white px-1 rounded">Phone number ID</code>{" "}
                    والصقه في الخانة تحت (مش رقم الموبايل — الـ ID رقمي بـ 15-17 خانة)
                  </li>
                  <li>
                    أنشئ{" "}
                    <a
                      href="https://developers.facebook.com/docs/whatsapp/business-management-api/get-started"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      System User Token دائم{" "}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {" "}بصلاحيتي{" "}
                    <code className="bg-white px-1 rounded">whatsapp_business_messaging</code>{" "}
                    و{" "}
                    <code className="bg-white px-1 rounded">whatsapp_business_management</code>،
                    والصقه في خانة Access Token (التوكن المؤقت 24 ساعة لن يصلح
                    للإنتاج)
                  </li>
                  <li>
                    فعّل الخيار واضغط "حفظ الإعدادات"، ثم جرب الإرسال من
                    خانة الاختبار
                  </li>
                </ol>
                <p className="text-text-secondary leading-relaxed">
                  <strong>ملاحظات مهمة:</strong>
                </p>
                <ul className="list-disc list-inside space-y-0.5 text-text-secondary">
                  <li>
                    Meta بتسمح بإرسال رسائل حرّة فقط خلال{" "}
                    <b>نافذة 24 ساعة</b> بعد أول رسالة من العميل. الفواتير
                    بعد البيع غالباً ما تكون بره النافذة، لازم{" "}
                    <a
                      href="https://business.facebook.com/wa/manage/message-templates/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      تعتمد قالب رسالة{" "}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {" "}في Meta أو يبعت العميل أي رسالة الأول.
                  </li>
                  <li>
                    إرسال PDF شغّال في الحالتين (داخل أو خارج النافذة) لو
                    المرفق جزء من قالب موافَق عليه؛ غير كده يحتاج تأكيد
                    العميل أولاً.
                  </li>
                  <li>
                    القناة رسمية ومستقرة — لا تعرّض رقمك للحظر زي ما ممكن
                    يحصل مع Green API.
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
            <input
              type="checkbox"
              checked={draft.whatsappCloudEnabled}
              onChange={(e) =>
                update("whatsappCloudEnabled", e.target.checked)
              }
              className="mt-1 w-5 h-5 accent-accent"
            />
            <div className="flex-1">
              <p className="font-medium">
                تفعيل الإرسال التلقائي عبر WhatsApp Cloud API
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                لو مفعّل، الفاتورة تُرسل في الخلفية عبر القناة الرسمية. لو
                Green API و Cloud API الاتنين مفعّلين، البرنامج بيستخدم
                Cloud API.
              </p>
            </div>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Phone Number ID"
              value={draft.whatsappCloudPhoneId}
              onChange={(e) =>
                update("whatsappCloudPhoneId", e.target.value)
              }
              placeholder="123456789012345"
            />
            <Input
              label="Access Token (System User)"
              value={draft.whatsappCloudToken}
              onChange={(e) =>
                update("whatsappCloudToken", e.target.value)
              }
              type="password"
              placeholder="EAAG••••••••••••••••"
            />
          </div>
          <Input
            label="WhatsApp Business Account ID (اختياري)"
            value={draft.whatsappCloudBusinessId}
            onChange={(e) =>
              update("whatsappCloudBusinessId", e.target.value)
            }
            placeholder="987654321098765"
          />

          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">
              <Send className="w-4 h-4 text-accent" />
              اختبار الإرسال
            </p>
            <div className="flex gap-2">
              <input
                type="tel"
                inputMode="tel"
                value={cloudTestPhone}
                onChange={(e) => setCloudTestPhone(e.target.value)}
                placeholder="01000000000"
                dir="ltr"
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-white text-sm"
              />
              <Button
                onClick={handleCloudTestSend}
                loading={cloudTesting}
                disabled={
                  !draft.whatsappCloudPhoneId || !draft.whatsappCloudToken
                }
                className="whitespace-nowrap"
              >
                إرسال تجريبي
              </Button>
            </div>
            <p className="text-[10px] text-text-secondary">
              لو خرجت رسالة "Recipient phone number not in allowed list" فأنت
              لسه في وضع الاختبار — أضف رقم المستلم من شاشة API Setup أو
              اعتمد التطبيق ليخرج من sandbox.
            </p>
          </div>
          </>
          )}
        </div>

        {/* Message templates — Meta-approved library cached locally.
            Visible only when an OAuth connection exists (templates live
            on the WABA that connection points at). */}
        {connection && connection.status === "active" && (
          <div className="bg-white rounded-xl border border-border p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-bold text-lg">قوالب الرسائل (Meta)</h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  القوالب المعتمدة فقط هي اللي تقدر تستخدمها للإرسال خارج نافذة
                  الـ 24 ساعة. اعتمد القوالب من Meta Business Manager، بعدين
                  اضغط مزامنة هنا.
                </p>
              </div>
              <Button
                onClick={handleSyncTemplates}
                loading={templatesSyncing}
                disabled={!isOwner}
                className="!py-1.5 !text-xs whitespace-nowrap"
                variant="secondary"
              >
                مزامنة من Meta
              </Button>
            </div>

            {templatesLoading ? (
              <p className="text-xs text-text-secondary">جارٍ التحميل...</p>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-3 text-xs text-text-secondary">
                لا توجد قوالب مخزّنة بعد. أنشئ قوالبك في Meta Business Manager
                واضغط "مزامنة من Meta".
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border p-2.5 text-xs"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-medium">{t.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-main text-text-secondary">
                          {t.language}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            t.category === "authentication"
                              ? "bg-blue-100 text-blue-700"
                              : t.category === "utility"
                                ? "bg-success/15 text-success"
                                : t.category === "marketing"
                                  ? "bg-orange-100 text-orange-700"
                                  : "bg-bg-main text-text-secondary"
                          }`}
                        >
                          {t.category}
                        </span>
                      </div>
                      {t.rejectedReason && (
                        <p className="text-[11px] text-error mt-0.5">
                          {t.rejectedReason}
                        </p>
                      )}
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${
                        t.status === "approved"
                          ? "bg-success/15 text-success"
                          : t.status === "pending"
                            ? "bg-orange-100 text-orange-700"
                            : t.status === "rejected"
                              ? "bg-error/15 text-error"
                              : t.status === "stale"
                                ? "bg-bg-main text-text-secondary"
                                : "bg-bg-main text-text-secondary"
                      }`}
                    >
                      {t.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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

        <div className="flex items-center justify-between gap-3">
          {dirty ? (
            <p className="text-xs text-text-secondary">لديك تعديلات لم تُحفظ</p>
          ) : (
            <p className="text-xs text-text-secondary">لا توجد تعديلات</p>
          )}
          <Button
            onClick={handleSave}
            loading={busy}
            disabled={!dirty || busy}
            className="flex items-center gap-2"
          >
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

interface ReceiptCardProps {
  draft: ShopSettings;
  update: <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) => void;
}

function ReceiptCustomisationCard({ draft, update }: ReceiptCardProps) {
  // Live mock preview. Numbers are illustrative — the goal is to let the
  // owner see how their language/logo/footer choices will look without
  // having to ring up a real sale.
  const lang = draft.receiptLanguage;
  const T = (en: string, ar: string) =>
    lang === "en" ? en : lang === "ar" ? ar : `${en} · ${ar}`;
  const shopName = (draft.shopName || "STORE").toUpperCase();

  return (
    <div className="bg-white rounded-xl border border-border p-5 space-y-4">
      <div>
        <h3 className="font-bold text-lg">تخصيص الفاتورة</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          مظهر ولغة الإيصال المطبوع — كل فرع له إعداداته المستقلة.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Logo size */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            حجم الشعار
          </label>
          <select
            value={draft.receiptLogoSize}
            onChange={(e) =>
              update("receiptLogoSize", e.target.value as ShopSettings["receiptLogoSize"])
            }
            className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {LOGO_SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-text-secondary mt-1">
            لو طابعتك حرارية واللوجو طلع وحش، خليه «صغير» أو «بدون».
          </p>
        </div>

        {/* Language */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            لغة المسميات
          </label>
          <div className="space-y-1.5">
            {LANGUAGE_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                  draft.receiptLanguage === o.value
                    ? "border-accent bg-accent-light/30"
                    : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name="receipt-language"
                  checked={draft.receiptLanguage === o.value}
                  onChange={() =>
                    update("receiptLanguage", o.value)
                  }
                  className="mt-1 accent-accent"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{o.label}</p>
                  <p className="text-[10px] text-text-secondary truncate">
                    {o.hint}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Footer text */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1.5">
          نص ذيل الفاتورة (اختياري)
        </label>
        <textarea
          value={draft.receiptFooterText}
          onChange={(e) => update("receiptFooterText", e.target.value)}
          dir="rtl"
          rows={3}
          maxLength={500}
          placeholder="مثلاً: سياسة الإرجاع خلال 7 أيام بالفاتورة. تابعنا على إنستجرام @yourshop"
          className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <p className="text-[10px] text-text-secondary mt-1">
          {draft.receiptFooterText.length}/500 — يظهر تحت «شكراً لتسوقكم».
        </p>
      </div>

      {/* Show loyalty toggle */}
      <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
        <input
          type="checkbox"
          checked={draft.receiptShowLoyalty}
          onChange={(e) => update("receiptShowLoyalty", e.target.checked)}
          className="mt-1 w-5 h-5 accent-accent"
        />
        <div className="flex-1">
          <p className="font-medium">إظهار النقاط والرصيد على الفاتورة</p>
          <p className="text-xs text-text-secondary mt-0.5">
            يطبع «نقاط مكتسبة» و«رصيد المحفظة» — أقوى محفز لاستخدام برنامج
            الولاء. يحتاج برنامج الولاء مفعّل.
          </p>
        </div>
      </label>

      {/* Live preview — a thin facsimile of what the cashier will see on the
          printed receipt. Not pixel-perfect (real receipt is monospace at
          80mm) but conveys order, language, and logo size accurately. */}
      <div className="rounded-lg border border-dashed border-border bg-bg-main p-3">
        <p className="text-[10px] text-text-secondary mb-2 text-center">
          ↓ معاينة مبدئية ↓
        </p>
        <div className="mx-auto bg-white border border-border rounded p-3 max-w-xs text-[11px] leading-relaxed font-mono text-black">
          {draft.receiptLogoSize !== "hidden" && (
            <div className="text-center mb-1">
              <div
                className={`inline-block bg-bg-main rounded ${
                  draft.receiptLogoSize === "small"
                    ? "w-10 h-10"
                    : draft.receiptLogoSize === "large"
                      ? "w-24 h-24"
                      : "w-16 h-16"
                }`}
                aria-hidden
              />
            </div>
          )}
          <div className="text-center font-bold tracking-wide">{shopName}</div>
          {draft.shopPhone && (
            <div className="text-center">TEL: {draft.shopPhone}</div>
          )}
          <hr className="my-1 border-black" />
          <div className="text-center font-black tracking-widest">
            {T("*** RECEIPT ***", "*** فاتورة ***")}
          </div>
          <hr className="my-1 border-black" />
          <div className="flex justify-between">
            <span>SAMPLE ITEM</span>
            <span>100.00 ج.م</span>
          </div>
          <hr className="my-1 border-black" />
          <div className="flex justify-between">
            <span>{T("SUBTOTAL", "المجموع")}</span>
            <span>100.00 ج.م</span>
          </div>
          {draft.receiptShowLoyalty && draft.loyaltyEnabled && (
            <>
              <div className="flex justify-between">
                <span>{T("CREDIT APPLIED", "رصيد مستخدم")}</span>
                <span>- 10.00 ج.م</span>
              </div>
            </>
          )}
          <hr className="my-1 border-black" />
          <div className="flex justify-between font-black">
            <span>{T("TOTAL AMOUNT", "الإجمالي")}</span>
            <span>
              {draft.receiptShowLoyalty && draft.loyaltyEnabled
                ? "90.00"
                : "100.00"}{" "}
              ج.م
            </span>
          </div>
          {draft.receiptShowLoyalty && draft.loyaltyEnabled && (
            <>
              <hr className="my-1 border-black" />
              <div className="flex justify-between">
                <span>{T("POINTS EARNED", "نقاط مكتسبة")}</span>
                <span>+9</span>
              </div>
            </>
          )}
          <hr className="my-1 border-black" />
          <div className="text-center font-bold">
            {T("THANK YOU FOR SHOPPING!", "شكراً لتسوقكم معنا")}
          </div>
          {draft.receiptFooterText && (
            <div
              dir="rtl"
              className="text-center whitespace-pre-wrap mt-1 text-[10px]"
            >
              {draft.receiptFooterText}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
