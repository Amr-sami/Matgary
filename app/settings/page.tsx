"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
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
  History,
  DollarSign,
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
import { CategoriesEditor } from "@/components/settings/CategoriesEditor";
import { BrandsEditor } from "@/components/settings/BrandsEditor";
import { ReceiptDesigner } from "@/components/settings/ReceiptDesigner";

// Phase 4D — receipt customisation lives below the fold and adds ~7KB of
// JSX + live-preview math to the settings bundle. Lazy-loading defers
// that weight off the initial settings page bundle. `ssr: false` is fine
// here because the owner-only settings page is never indexed and the
// card has no SEO value.
const ReceiptCustomisationCard = dynamic(
  () =>
    import("@/components/settings/ReceiptCustomisationCard").then(
      (m) => m.default,
    ),
  { ssr: false, loading: () => <div className="h-64" aria-hidden /> },
);
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency, formatDateTime } from "@/lib/i18n/format";

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

const ERROR_STATE_CTA: Record<string, "reconnect" | "verify" | "retry"> = {
  token_expired: "reconnect",
  token_revoked: "reconnect",
  scope_missing: "reconnect",
  phone_unverified: "verify",
  waba_inaccessible: "reconnect",
  network: "retry",
};

const PLACEHOLDER_KEYS = [
  "customerName",
  "customerPhone",
  "invoiceId",
  "invoiceCode",
  "totalPrice",
  "productNames",
  "receiptLink",
  "date",
  "shopName",
  "shopPhone",
] as const;

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
    a.receiptTemplateName === b.receiptTemplateName &&
    a.receiptTemplateLanguage === b.receiptTemplateLanguage &&
    a.sendAsPdf === b.sendAsPdf &&
    a.loyaltyEnabled === b.loyaltyEnabled &&
    a.loyaltyPointsPerEgp === b.loyaltyPointsPerEgp &&
    a.loyaltyEgpPerPoint === b.loyaltyEgpPerPoint &&
    a.receiptLogoSize === b.receiptLogoSize &&
    a.receiptFooterText === b.receiptFooterText &&
    a.receiptLanguage === b.receiptLanguage &&
    a.receiptShowLoyalty === b.receiptShowLoyalty &&
    a.receiptLogoUrl === b.receiptLogoUrl &&
    a.receiptFontFamily === b.receiptFontFamily &&
    a.receiptBlockOrder.length === b.receiptBlockOrder.length &&
    a.receiptBlockOrder.every((k, i) => k === b.receiptBlockOrder[i])
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.settingsPage;
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
        const upserted = String(json.upserted ?? 0);
        const fetched = json.fetched ?? 0;
        setToast({
          type: "success",
          message: fetched > 0
            ? t.toast.templatesSyncedFrom
                .replace("{n}", upserted)
                .replace("{total}", String(fetched))
            : t.toast.templatesSynced.replace("{n}", upserted),
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
          ? t.toast.connectOkDetail.replace("{detail}", detail)
          : t.toast.connectOk,
      });
      refreshConnection();
    } else {
      setToast({
        type: "error",
        message: detail || t.toast.connectFailed,
      });
    }
    // Strip the flash params so a refresh doesn't re-fire the toast.
    router.replace("/settings");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router]);

  const handleConnect = () => {
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
          message: json.note || (json.ok ? t.toast.healthOk : t.toast.healthFailed),
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
    if (!confirm(t.toast.confirmDisconnect)) return;
    setDisconnecting(true);
    try {
      const res = await fetch("/api/whatsapp/oauth/disconnect", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.ok) {
        setToast({ type: "success", message: t.toast.disconnected });
        await refreshConnection();
      } else {
        setToast({ type: "error", message: json?.error || t.toast.disconnectFailed });
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
      await Promise.all([refreshLocalSettings(), refreshGlobalSettings()]);
      setToast({ type: "success", message: t.toast.saveSuccess });
    } catch (e: any) {
      setToast({ type: "error", message: e.message || t.toast.saveFailed });
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
      setToast({ type: "error", message: t.toast.needPhone });
      return;
    }
    if (!draft.greenApiInstanceId.trim() || !draft.greenApiToken.trim()) {
      setToast({ type: "error", message: t.toast.needGreenCreds });
      return;
    }
    setTesting(true);
    try {
      const res = await sendViaGreenApi({
        phone: testPhone.trim(),
        message: t.greenApi.testMessage
          .replace("{shop}", draft.shopName)
          .replace("{date}", formatDateTime(new Date(), locale)),
      });
      if (res.ok) {
        setToast({
          type: "success",
          message: t.toast.sendOk.replace("{id}", res.idMessage || "—"),
        });
      } else {
        setToast({
          type: "error",
          message: res.error || t.toast.sendFailed,
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleCloudTestSend = async () => {
    if (!cloudTestPhone.trim()) {
      setToast({ type: "error", message: t.toast.needPhone });
      return;
    }
    if (!draft.whatsappCloudPhoneId.trim() || !draft.whatsappCloudToken.trim()) {
      setToast({ type: "error", message: t.toast.needCloudCreds });
      return;
    }
    setCloudTesting(true);
    try {
      const res = await sendViaWhatsAppCloud({
        phone: cloudTestPhone.trim(),
        message: t.greenApi.testMessage
          .replace("{shop}", draft.shopName)
          .replace("{date}", formatDateTime(new Date(), locale)),
      });
      if (res.ok) {
        setToast({
          type: "success",
          message: t.toast.sendOk.replace("{id}", res.idMessage || "—"),
        });
      } else {
        setToast({
          type: "error",
          message: res.error || t.toast.sendFailed,
        });
      }
    } finally {
      setCloudTesting(false);
    }
  };

  // Live preview using sample data
  const previewMessage = substitute(draft.messageTemplate, {
    customerName: t.messageTemplate.sampleCustomer,
    customerPhone: "01552190743",
    invoiceId: "INV-MOLI6XQ7ZL8YKA",
    invoiceCode: "L6XQ7ZL8",
    totalPrice: formatCurrency(2500, locale),
    productNames: t.messageTemplate.sampleProducts,
    receiptLink: "",
    date: formatDateTime(new Date(), locale),
    shopName: draft.shopName,
    shopPhone: draft.shopPhone,
  });

  if (loading) {
    return (
      <AppShell title={t.title}>
        <div className="text-center py-20 text-text-secondary">
          {t.loading}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t.title}>
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Branches — owner-only entry point. */}
        {isOwner && (
          <Link
            href="/settings/branches"
            className="group block bg-white rounded-xl border border-border p-5 hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-3">
              <Store className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-text-primary">{t.branches.title}</h3>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-bg-main text-text-secondary tabular-nums">
                    {branchCount}{" "}
                    {branchCount === 1 ? t.branches.countOne : t.branches.countMany}
                  </span>
                </div>
                <p className="text-xs text-text-secondary mt-0.5">
                  {branchCount <= 1 ? t.branches.hintOne : t.branches.hintMany}
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
            </div>
          </Link>
        )}

        {/* Cash drawer reconciliation — owner-only. */}
        {isOwner && (
          <Link
            href="/settings/cash-drawer"
            className="group block bg-white rounded-xl border border-border p-5 hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-3">
              <DollarSign className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-text-primary">
                  {t.cashDrawerTile.title}
                </h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  {t.cashDrawerTile.subtitle}
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
            </div>
          </Link>
        )}

        {/* Daily owner digest — owner-only. */}
        {isOwner && (
          <Link
            href="/settings/digest"
            className="group block bg-white rounded-xl border border-border p-5 hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-3">
              <MessageCircle className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-text-primary">
                  {t.digestTile.title}
                </h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  {t.digestTile.subtitle}
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
            </div>
          </Link>
        )}

        {/* Activity log — moved here from the sidebar. Owner-only by default
            (matches the `view_activity_log` permission catalog default). */}
        {isOwner && (
          <Link
            href="/activity"
            className="group block bg-white rounded-xl border border-border p-5 hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-3">
              <History className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-text-primary">
                  {t.activityTile.title}
                </h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  {t.activityTile.subtitle}
                </p>
              </div>
              <ChevronLeft className="w-5 h-5 text-text-secondary shrink-0 group-hover:text-accent transition-colors" />
            </div>
          </Link>
        )}

        <CategoriesEditor onToast={setToast} />
        <BrandsEditor onToast={setToast} />

        {/* Loyalty programme */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-bold text-lg">{t.loyalty.title}</h3>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.loyalty.subtitle}
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
                {draft.loyaltyEnabled ? t.loyalty.enabled : t.loyalty.disabled}
              </span>
            </label>
          </div>

          {draft.loyaltyEnabled && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input
                  label={t.loyalty.pointsPerEgp}
                  type="number"
                  step="0.01"
                  min="0"
                  value={String(draft.loyaltyPointsPerEgp)}
                  onChange={(e) =>
                    update("loyaltyPointsPerEgp", Number(e.target.value) || 0)
                  }
                  placeholder={t.loyalty.pointsPerEgpPlaceholder}
                />
                <Input
                  label={t.loyalty.egpPerPoint}
                  type="number"
                  step="0.01"
                  min="0"
                  value={String(draft.loyaltyEgpPerPoint)}
                  onChange={(e) =>
                    update("loyaltyEgpPerPoint", Number(e.target.value) || 0)
                  }
                  placeholder={t.loyalty.egpPerPointPlaceholder}
                />
              </div>

              <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs text-text-secondary leading-relaxed">
                <p className="font-medium text-text-primary mb-1">{t.loyalty.exampleLabel}</p>
                {(() => {
                  const earned = Math.floor(100 * draft.loyaltyPointsPerEgp);
                  const value = formatCurrency(
                    earned * draft.loyaltyEgpPerPoint,
                    locale,
                  );
                  return (
                    <>
                      <p
                        dangerouslySetInnerHTML={{
                          __html: t.loyalty.exampleBody
                            .replace("{earned}", String(earned))
                            .replace("{value}", value),
                        }}
                      />
                      {draft.loyaltyPointsPerEgp === 0 &&
                        draft.loyaltyEgpPerPoint === 0 && (
                          <p className="mt-1 text-orange-600">
                            {t.loyalty.exampleWarning}
                          </p>
                        )}
                    </>
                  );
                })()}
              </div>
            </>
          )}
        </div>

        <ReceiptCustomisationCard draft={draft} update={update} />

        <ReceiptDesigner
          draft={draft}
          update={update}
          onError={(message) =>
            setToast({ type: "error", message })
          }
        />

        {/* WhatsApp section */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-success" />
            <h3 className="font-bold text-lg">{t.whatsapp.section}</h3>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer">
            <input
              type="checkbox"
              checked={draft.autoOpenWhatsApp}
              onChange={(e) => update("autoOpenWhatsApp", e.target.checked)}
              className="mt-1 w-5 h-5 accent-accent"
            />
            <div className="flex-1">
              <p className="font-medium">{t.whatsapp.autoOpen}</p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.whatsapp.autoOpenHint}
              </p>
            </div>
          </label>

        </div>

        {/* Green API */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-success" />
            <h3 className="font-bold text-lg">{t.greenApi.section}</h3>
          </div>

          <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs space-y-1.5">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <p className="font-medium">{t.greenApi.stepsTitle}</p>
                <ol className="list-decimal list-inside space-y-0.5 text-text-secondary">
                  <li>
                    {t.greenApi.step1Prefix}
                    <a
                      href="https://green-api.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      green-api.com <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>{t.greenApi.step2}</li>
                  <li>{t.greenApi.step3}</li>
                  <li>{t.greenApi.step4}</li>
                  <li>{t.greenApi.step5}</li>
                </ol>
                <p
                  className="text-orange-700 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: t.greenApi.warning }}
                />
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
              <p className="font-medium">{t.greenApi.enable}</p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.greenApi.enableHint}
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
              <p className="font-medium">{t.greenApi.sendAsPdf}</p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.greenApi.sendAsPdfHint}
              </p>
            </div>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={t.greenApi.instanceLabel}
              value={draft.greenApiInstanceId}
              onChange={(e) => update("greenApiInstanceId", e.target.value)}
              placeholder="7107606136"
            />
            <Input
              label={t.greenApi.tokenLabel}
              value={draft.greenApiToken}
              onChange={(e) => update("greenApiToken", e.target.value)}
              type="password"
              placeholder={t.greenApi.tokenPlaceholder}
            />
          </div>
          <Input
            label={t.greenApi.urlLabel}
            value={draft.greenApiUrl}
            onChange={(e) => update("greenApiUrl", e.target.value)}
            placeholder="https://7107.api.greenapi.com"
          />

          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">
              <Send className="w-4 h-4 text-accent" />
              {t.greenApi.testHeading}
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
                {t.greenApi.testButton}
              </Button>
            </div>
            <p className="text-[10px] text-text-secondary">
              {t.greenApi.testHint}
            </p>
          </div>
        </div>

        {/* WhatsApp Business Cloud API (Meta — official) */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-accent" />
            <h3 className="font-bold text-lg">{t.cloudApi.section}</h3>
          </div>

          {connectionLoading ? (
            <div className="rounded-lg border border-border p-3 text-xs text-text-secondary">
              {t.cloudApi.checkingConnection}
            </div>
          ) : connection && connection.status === "active" ? (
            <div className="rounded-lg border border-success/40 bg-success/5 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-medium text-sm flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-success" />
                    {t.cloudApi.connected}
                  </p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    <span dir="auto">{connection.verifiedName || "—"}</span>{" "}
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
                    {connection.mode === "live"
                      ? t.cloudApi.modeLive
                      : t.cloudApi.modeSandbox}
                  </span>
                  {!connection.webhookSubscribed && (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700"
                      title={t.cloudApi.webhookPendingTitle}
                    >
                      {t.cloudApi.webhookPending}
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
                  {t.cloudApi.connectedAt.replace(
                    "{date}",
                    formatDateTime(new Date(connection.connectedAt), locale),
                  )}
                </div>
              </div>
              {connection.connectionErrorState &&
                connection.connectionErrorState !== "ok" && (
                  <div className="rounded-md border border-orange-300 bg-orange-50 p-2 text-xs space-y-1">
                    <p className="font-medium text-orange-800">
                      {(t.cloudApi.errorState as Record<string, string>)[
                        connection.connectionErrorState
                      ] ||
                        connection.lastError ||
                        t.cloudApi.errorFallback}
                    </p>
                    {(() => {
                      const cta = ERROR_STATE_CTA[connection.connectionErrorState!];
                      if (cta === "reconnect") {
                        return (
                          <Button
                            onClick={handleConnect}
                            className="!py-1 !text-[11px]"
                            variant="secondary"
                          >
                            {t.cloudApi.reconnect}
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
                            {t.cloudApi.retry}
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
                  {t.cloudApi.healthCheck}
                </Button>
                <Button
                  onClick={handleConnect}
                  className="!py-1.5 !text-xs"
                  variant="secondary"
                >
                  {t.cloudApi.reconnectShort}
                </Button>
                <Button
                  onClick={handleDisconnect}
                  loading={disconnecting}
                  variant="ghost"
                  className="!py-1.5 !text-xs text-error"
                >
                  {t.cloudApi.disconnect}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-4 space-y-2">
              <p className="font-medium text-sm">{t.cloudApi.notConnected}</p>
              <p className="text-xs text-text-secondary leading-relaxed">
                {t.cloudApi.connectIntro}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleConnect} className="!py-2">
                  {t.cloudApi.connectButton}
                </Button>
                <button
                  type="button"
                  onClick={() => setShowManualCloudFields((v) => !v)}
                  className="text-xs text-text-secondary hover:text-accent underline underline-offset-4"
                >
                  {showManualCloudFields
                    ? t.cloudApi.toggleManualHide
                    : t.cloudApi.toggleManualShow}
                </button>
              </div>
              {connection?.lastError && (
                <p className="text-[11px] text-error">
                  {t.cloudApi.lastError.replace("{message}", connection.lastError)}
                </p>
              )}
            </div>
          )}

          {(showManualCloudFields ||
            (!connection &&
              (draft.whatsappCloudPhoneId || draft.whatsappCloudToken))) && (
          <>
          <div className="rounded-lg bg-accent-light/30 border border-accent-light p-3 text-xs space-y-1.5">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <p className="font-medium">{t.cloudApi.manualStepsTitle}</p>
                <ol className="list-decimal list-inside space-y-0.5 text-text-secondary">
                  <li>
                    {t.cloudApi.manualSteps.step1.prefix}
                    <a
                      href="https://business.facebook.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      {t.cloudApi.manualSteps.step1.linkText} <ExternalLink className="w-3 h-3" />
                    </a>
                    <span
                      dangerouslySetInnerHTML={{
                        __html: t.cloudApi.manualSteps.step1.suffixHtml,
                      }}
                    />
                  </li>
                  <li>
                    {t.cloudApi.manualSteps.step2.prefix}
                    <a
                      href="https://developers.facebook.com/apps"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      {t.cloudApi.manualSteps.step2.linkText} <ExternalLink className="w-3 h-3" />
                    </a>
                    <span
                      dangerouslySetInnerHTML={{
                        __html: t.cloudApi.manualSteps.step2.suffixHtml,
                      }}
                    />
                  </li>
                  <li
                    dangerouslySetInnerHTML={{
                      __html: t.cloudApi.manualSteps.step3Html,
                    }}
                  />
                  <li
                    dangerouslySetInnerHTML={{
                      __html: t.cloudApi.manualSteps.step4Html,
                    }}
                  />
                  <li>
                    {t.cloudApi.manualSteps.step5.prefix}
                    <a
                      href="https://developers.facebook.com/docs/whatsapp/business-management-api/get-started"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      {t.cloudApi.manualSteps.step5.linkText} <ExternalLink className="w-3 h-3" />
                    </a>
                    <span
                      dangerouslySetInnerHTML={{
                        __html: t.cloudApi.manualSteps.step5.suffixHtml,
                      }}
                    />
                  </li>
                  <li>{t.cloudApi.manualSteps.step6}</li>
                </ol>
                <p
                  className="text-text-secondary leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: t.cloudApi.manualImportantNotes }}
                />
                <ul className="list-disc list-inside space-y-0.5 text-text-secondary">
                  <li dangerouslySetInnerHTML={{ __html: t.cloudApi.manualNotes.windowHtml }} />
                  <li>{t.cloudApi.manualNotes.pdf}</li>
                  <li>{t.cloudApi.manualNotes.official}</li>
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
              <p className="font-medium">{t.cloudApi.manualEnable}</p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.cloudApi.manualEnableHint}
              </p>
            </div>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={t.cloudApi.phoneIdLabel}
              value={draft.whatsappCloudPhoneId}
              onChange={(e) =>
                update("whatsappCloudPhoneId", e.target.value)
              }
              placeholder="123456789012345"
            />
            <Input
              label={t.cloudApi.tokenLabel}
              value={draft.whatsappCloudToken}
              onChange={(e) =>
                update("whatsappCloudToken", e.target.value)
              }
              type="password"
              placeholder="EAAG••••••••••••••••"
            />
          </div>
          <Input
            label={t.cloudApi.businessIdLabel}
            value={draft.whatsappCloudBusinessId}
            onChange={(e) =>
              update("whatsappCloudBusinessId", e.target.value)
            }
            placeholder="987654321098765"
          />

          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">
              <Send className="w-4 h-4 text-accent" />
              {t.cloudApi.testHeading}
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
                {t.cloudApi.testButton}
              </Button>
            </div>
            <p className="text-[10px] text-text-secondary">
              {t.cloudApi.testHint}
            </p>
          </div>
          </>
          )}
        </div>

        {/* Message templates */}
        {connection && connection.status === "active" && (
          <div className="bg-white rounded-xl border border-border p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-bold text-lg">{t.templates.section}</h3>
                <p className="text-xs text-text-secondary mt-0.5">
                  {t.templates.subhead}
                </p>
              </div>
              <Button
                onClick={handleSyncTemplates}
                loading={templatesSyncing}
                disabled={!isOwner}
                className="!py-1.5 !text-xs whitespace-nowrap"
                variant="secondary"
              >
                {t.templates.syncButton}
              </Button>
            </div>

            {templatesLoading ? (
              <p className="text-xs text-text-secondary">{t.templates.loading}</p>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-3 text-xs text-text-secondary">
                {t.templates.empty}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border p-2.5 text-xs"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-medium" dir="ltr">{tpl.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-main text-text-secondary">
                          {tpl.language}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            tpl.category === "authentication"
                              ? "bg-blue-100 text-blue-700"
                              : tpl.category === "utility"
                                ? "bg-success/15 text-success"
                                : tpl.category === "marketing"
                                  ? "bg-orange-100 text-orange-700"
                                  : "bg-bg-main text-text-secondary"
                          }`}
                        >
                          {tpl.category}
                        </span>
                      </div>
                      {tpl.rejectedReason && (
                        <p className="text-[11px] text-error mt-0.5">
                          {tpl.rejectedReason}
                        </p>
                      )}
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${
                        tpl.status === "approved"
                          ? "bg-success/15 text-success"
                          : tpl.status === "pending"
                            ? "bg-orange-100 text-orange-700"
                            : tpl.status === "rejected"
                              ? "bg-error/15 text-error"
                              : tpl.status === "stale"
                                ? "bg-bg-main text-text-secondary"
                                : "bg-bg-main text-text-secondary"
                      }`}
                    >
                      {tpl.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-lg border border-border p-3 space-y-2">
              <div>
                <p className="text-sm font-medium">{t.templates.receiptTitle}</p>
                <p className="text-[11px] text-text-secondary leading-relaxed mt-0.5">
                  {t.templates.receiptHint}{" "}
                  <code className="bg-bg-main px-1 rounded">{"{{1}}"}</code>{" "}
                  {t.templates.receiptVarCustomer} ·{" "}
                  <code className="bg-bg-main px-1 rounded">{"{{2}}"}</code>{" "}
                  {t.templates.receiptVarInvoice} ·{" "}
                  <code className="bg-bg-main px-1 rounded">{"{{3}}"}</code>{" "}
                  {t.templates.receiptVarTotal} ·{" "}
                  <code className="bg-bg-main px-1 rounded">{"{{4}}"}</code>{" "}
                  {t.templates.receiptVarProducts}.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-2">
                <select
                  value={
                    draft.receiptTemplateName && draft.receiptTemplateLanguage
                      ? `${draft.receiptTemplateName}::${draft.receiptTemplateLanguage}`
                      : ""
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) {
                      update("receiptTemplateName", "");
                      update("receiptTemplateLanguage", "");
                      return;
                    }
                    const [name, lang] = v.split("::");
                    update("receiptTemplateName", name);
                    update("receiptTemplateLanguage", lang);
                  }}
                  className="px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option value="">{t.templates.noTemplate}</option>
                  {templates
                    .filter(
                      (tpl) =>
                        tpl.status === "approved" &&
                        (tpl.category === "utility" ||
                          tpl.category === "authentication"),
                    )
                    .map((tpl) => (
                      <option
                        key={tpl.id}
                        value={`${tpl.name}::${tpl.language}`}
                      >
                        {tpl.name} ({tpl.language})
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    update("receiptTemplateName", "");
                    update("receiptTemplateLanguage", "");
                  }}
                  className="text-xs text-text-secondary hover:text-error border border-border rounded-lg px-3 py-2"
                  disabled={
                    !draft.receiptTemplateName && !draft.receiptTemplateLanguage
                  }
                >
                  {t.templates.clear}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Shop info */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Store className="w-5 h-5 text-accent" />
            <h3 className="font-bold text-lg">{t.shopInfo.section}</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={t.shopInfo.shopNameLabel}
              value={draft.shopName}
              onChange={(e) => update("shopName", e.target.value)}
            />
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                {t.shopInfo.phoneLabel}
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
                {t.shopInfo.phoneHint}
              </p>
            </div>
          </div>
        </div>

        {/* Template */}
        <div className="bg-white rounded-xl border border-border p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-accent" />
              <h3 className="font-bold text-lg">{t.messageTemplate.section}</h3>
            </div>
            <button
              onClick={handleResetTemplate}
              className="text-xs text-text-secondary hover:text-accent"
            >
              {t.messageTemplate.resetDefault}
            </button>
          </div>

          <textarea
            value={draft.messageTemplate}
            onChange={(e) => update("messageTemplate", e.target.value)}
            dir="auto"
            rows={10}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />

          <div>
            <p className="text-xs text-text-secondary mb-2">
              {t.messageTemplate.varsHint}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDER_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleInsertPlaceholder(key)}
                  className="text-[11px] px-2 py-1 rounded-md bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors"
                  title={t.messageTemplate.vars[key]}
                >
                  {`{${key}}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-text-secondary mb-1.5">
              {t.messageTemplate.previewLabel}
            </p>
            <div
              dir="auto"
              className="whitespace-pre-wrap rounded-lg border border-border bg-bg-main p-3 text-sm leading-relaxed font-mono"
            >
              {previewMessage}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          {dirty ? (
            <p className="text-xs text-text-secondary">{t.dirty}</p>
          ) : (
            <p className="text-xs text-text-secondary">{t.clean}</p>
          )}
          <Button
            onClick={handleSave}
            loading={busy}
            disabled={!dirty || busy}
            className="flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {t.save}
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

