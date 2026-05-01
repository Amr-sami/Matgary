import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "./firebase";

export const SETTINGS_DOC_ID = "whatsapp";

export const DEFAULT_TEMPLATE = `أهلاً {customerName} 👋
شكراً لشرائك من {shopName} ❤️

تفاصيل الفاتورة:
• {productNames}
• الإجمالي: {totalPrice}
• رقم الفاتورة: #{invoiceCode}

رابط الفاتورة: {receiptLink}

نتشرف بزيارتك مرة أخرى!
{shopPhone}`;

export interface ShopSettings {
  // When true, after recording a sale with a customer phone the form
  // automatically opens WhatsApp Web/app with the templated message.
  // Used as the fallback path if Green API is not enabled.
  autoOpenWhatsApp: boolean;
  // Message template — supports placeholders. See substitute() below.
  messageTemplate: string;
  // Public-facing storefront / contact info used in the template.
  shopName: string;
  shopPhone: string;
  // Green API integration — when enabled and creds are filled, sales
  // trigger a server-side send via /api/whatsapp/send instead of
  // opening wa.me in a tab.
  greenApiEnabled: boolean;
  greenApiInstanceId: string;
  greenApiToken: string;
}

export const DEFAULT_SETTINGS: ShopSettings = {
  autoOpenWhatsApp: true,
  messageTemplate: DEFAULT_TEMPLATE,
  shopName: "Corner Store",
  shopPhone: "01500228266",
  greenApiEnabled: false,
  greenApiInstanceId: "",
  greenApiToken: "",
};

export interface ReceiptVars {
  customerName: string;
  customerPhone: string;
  invoiceId: string;
  invoiceCode: string;
  totalPrice: string;
  productNames: string;
  receiptLink: string;
  date: string;
  shopName: string;
  shopPhone: string;
}

export function substitute(template: string, vars: ReceiptVars): string {
  const lookup = vars as unknown as Record<string, string>;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = lookup[key];
    return v !== undefined ? v : `{${key}}`;
  });
}

export function subscribeToSettings(
  callback: (s: ShopSettings) => void
): () => void {
  const ref = doc(db, "appSettings", SETTINGS_DOC_ID);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        callback(DEFAULT_SETTINGS);
        return;
      }
      const data = snap.data() as Partial<ShopSettings>;
      callback({
        autoOpenWhatsApp:
          typeof data.autoOpenWhatsApp === "boolean"
            ? data.autoOpenWhatsApp
            : DEFAULT_SETTINGS.autoOpenWhatsApp,
        messageTemplate:
          typeof data.messageTemplate === "string" && data.messageTemplate.trim()
            ? data.messageTemplate
            : DEFAULT_SETTINGS.messageTemplate,
        shopName: data.shopName || DEFAULT_SETTINGS.shopName,
        shopPhone: data.shopPhone || DEFAULT_SETTINGS.shopPhone,
        greenApiEnabled:
          typeof data.greenApiEnabled === "boolean"
            ? data.greenApiEnabled
            : DEFAULT_SETTINGS.greenApiEnabled,
        greenApiInstanceId:
          typeof data.greenApiInstanceId === "string"
            ? data.greenApiInstanceId
            : DEFAULT_SETTINGS.greenApiInstanceId,
        greenApiToken:
          typeof data.greenApiToken === "string"
            ? data.greenApiToken
            : DEFAULT_SETTINGS.greenApiToken,
      });
    },
    (err) => {
      console.error("[settings] snapshot error", err);
      callback(DEFAULT_SETTINGS);
    }
  );
}

export async function saveSettings(s: ShopSettings): Promise<void> {
  const ref = doc(db, "appSettings", SETTINGS_DOC_ID);
  await setDoc(ref, s, { merge: true });
}

export function normalizePhone(phone: string): string | null {
  const cleaned = (phone || "").replace(/\D/g, "");
  if (!cleaned) return null;
  // Egypt: 11-digit local starting with 0 → "20" + rest
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return "20" + cleaned.slice(1);
  }
  return cleaned;
}

export function buildWhatsAppLink(
  customerPhone: string,
  message: string
): string | null {
  const normalized = normalizePhone(customerPhone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
