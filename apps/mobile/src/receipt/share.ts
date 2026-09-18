/**
 * The day-one printing path (doc 06 §1.4 "system.ts"): expo-print renders the
 * receipt HTML to a PDF, expo-sharing hands it to WhatsApp / Files / Mail, and
 * expo-print's printAsync drives AirPrint (iOS) or the Android print service.
 * Zero native work, matches the web's ShareReceiptButton behaviour.
 *
 * The ESC/POS transports land beside this file later (ble.ts / tcp.ts); they
 * reuse `prepareReceipt()` for the data and their own renderer for the bytes.
 */

import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import type { QueryClient } from "@tanstack/react-query";
import { createMMKV } from "react-native-mmkv";
import { calcLineDiscount, type DiscountType } from "@matgary/domain";
import { settings as settingsApi, type sales as salesApi } from "@matgary/api-client";

import { API_BASE_URL, api } from "@/api/client";
import { t } from "@/i18n";
import { useSession } from "@/stores/session";
import {
  DEFAULT_RECEIPT_SETTINGS,
  buildReceiptHtml,
  receiptLogoUrl,
  receiptPageSize,
  receiptQrPayload,
  type ReceiptSale,
  type ReceiptSettings,
  type ReceiptWidth,
} from "./html";

// ---------------------------------------------------------------------------
// Device store — paper width (a per-counter preference) and the last receipt
// settings the shop served, so an offline till still prints the shop's header.

const store = createMMKV({ id: "receipt" });
const WIDTH_KEY = "paperWidth";
const SETTINGS_KEY_PREFIX = "settings:";

export function getReceiptWidth(): ReceiptWidth {
  try {
    return store.getNumber(WIDTH_KEY) === 58 ? 58 : 80;
  } catch {
    return 80;
  }
}

export function setReceiptWidth(w: ReceiptWidth): void {
  try {
    store.set(WIDTH_KEY, w);
  } catch {
    // preference only — a failed write is not worth surfacing
  }
}

// ---------------------------------------------------------------------------
// Adapter: the cart the cashier rang up + what POST /api/sales/cart returned
// → what the receipt renders.

/** The slice of a cart line the receipt needs — `CartLine` from stores/cart satisfies it. */
export interface ReceiptCartLine {
  name: string;
  brand?: string | null;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType: DiscountType;
  lineDiscountValue: number;
}

export interface ReceiptCart {
  lines: ReceiptCartLine[];
  orderDiscountType: DiscountType;
  orderDiscountValue: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Snapshot the cart BEFORE `cart.reset()` and pair it with the server result.
 * The cart result alone carries only net line totals, which would print a
 * discounted SUBTOTAL, derived unit prices and no BRAND — the web receipt
 * (SaleForm.tsx) prints gross subtotal, per-line discount and order discount,
 * and the customer's phone PDF must read the same.
 *
 * `result.total` is what the server booked; the gap between the discounted
 * lines and that figure is the order discount (the server caps it exactly as
 * `computeCartTotals` does), so the printed math always reconciles to the
 * amount actually charged.
 */
export function toReceiptSale(
  cart: ReceiptCart,
  result: salesApi.CartSaleResult,
  extra: { saleDate?: Date; amountPaid?: number } = {},
): ReceiptSale {
  const lines = cart.lines.map((l) => ({
    productName: l.name,
    brand: l.brand ?? null,
    quantity: l.quantity,
    pricePerUnit: l.pricePerUnit,
    subtotal: round2(l.quantity * l.pricePerUnit),
    lineDiscountAmount: calcLineDiscount(l.quantity, l.pricePerUnit, l.lineDiscountType, l.lineDiscountValue),
  }));
  const cartSubtotal = round2(lines.reduce((s, l) => s + l.subtotal, 0));
  const afterLines = cartSubtotal - lines.reduce((s, l) => s + l.lineDiscountAmount, 0);
  const orderDiscountAmount = Math.max(0, round2(afterLines - result.total));
  return {
    invoiceId: result.invoiceId,
    saleDate: extra.saleDate ?? new Date(),
    lines,
    cartSubtotal,
    orderDiscountAmount,
    totalPrice: result.total,
    amountPaid: result.paymentMethod === "deferred" ? extra.amountPaid ?? 0 : extra.amountPaid,
  };
}

// ---------------------------------------------------------------------------
// Settings — GET /api/settings, the same document the web receipt reads.
//
// Read through the app's QueryClient under ["shop-settings"] so the settings
// screen's `invalidateQueries({ queryKey: ["shop-settings"] })` after a save
// reaches the next receipt too (no private cache to go stale). Every
// successful load is mirrored into MMKV, keyed by tenant, so an offline till
// with a cold query cache still prints the shop's own header and footer.

const SETTINGS_QUERY_KEY = ["shop-settings"] as const;

function settingsStorageKey(): string | null {
  const tenantId = useSession.getState().me?.tenant.id;
  return tenantId ? `${SETTINGS_KEY_PREFIX}${tenantId}` : null;
}

function mergeSettings(data: Partial<ReceiptSettings>): ReceiptSettings {
  return { ...DEFAULT_RECEIPT_SETTINGS, ...data };
}

function readPersistedSettings(): ReceiptSettings | null {
  const key = settingsStorageKey();
  if (!key) return null;
  try {
    const raw = store.getString(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return mergeSettings(parsed as Partial<ReceiptSettings>);
  } catch {
    return null;
  }
}

function persistSettings(settings: ReceiptSettings): void {
  const key = settingsStorageKey();
  if (!key) return;
  try {
    store.set(key, JSON.stringify(settings));
  } catch {
    // best effort — the next online load will try again
  }
}

/** Where the settings that will print came from. */
export type ReceiptSettingsSource = "live" | "saved" | "default";

export interface LoadedReceiptSettings {
  settings: ReceiptSettings;
  source: ReceiptSettingsSource;
  /**
   * true when nothing tenant-specific was available and the generic defaults
   * (no shop name, no phone, no footer) are what would print. Callers must
   * surface this BEFORE rendering — the paper goes home with the customer.
   */
  fallback: boolean;
}

export async function loadReceiptSettings(qc: QueryClient): Promise<LoadedReceiptSettings> {
  try {
    const res = await qc.fetchQuery({
      queryKey: SETTINGS_QUERY_KEY,
      queryFn: () => settingsApi.getShopSettings(api),
      staleTime: 60_000,
    });
    const settings = mergeSettings(res.data);
    persistSettings(settings);
    return { settings, source: "live", fallback: false };
  } catch {
    const stale = qc.getQueryData<settingsApi.ShopSettingsResponse>(SETTINGS_QUERY_KEY)?.data;
    const saved = stale ? mergeSettings(stale) : readPersistedSettings();
    if (saved) return { settings: saved, source: "saved", fallback: false };
    return { settings: DEFAULT_RECEIPT_SETTINGS, source: "default", fallback: true };
  }
}

// ---------------------------------------------------------------------------
// Images → data URIs. The PDF snapshot does not wait for remote <img>s.

/** Only raster/vector image data URIs may reach the `src` attribute. */
const IMAGE_DATA_URI = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[a-z0-9-]+)*;base64,[a-z0-9+/=\s]*$/i;

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onloadend = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function inlineImage(url: string, timeoutMs = 4000): Promise<string | undefined> {
  if (url.startsWith("data:")) return IMAGE_DATA_URI.test(url) ? url : undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return undefined;
    const uri = await blobToDataUri(blob);
    return IMAGE_DATA_URI.test(uri) ? uri : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Same generator the web uses — keeps the two QRs scanning to the same payload. */
function qrImageUrl(payload: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&ecc=M&data=${encodeURIComponent(payload)}`;
}

// ---------------------------------------------------------------------------

export interface PreparedReceipt {
  html: string;
  width: number;
  height: number;
  settings: ReceiptSettings;
  source: ReceiptSettingsSource;
  fallback: boolean;
}

/**
 * Everything a renderer needs, resolved once. Never throws — degrades.
 * Pass `loaded` when the caller already resolved settings (to confirm a
 * defaults fallback with the cashier first) so they are not fetched twice.
 */
export async function prepareReceipt(
  sale: ReceiptSale,
  qc: QueryClient,
  width: ReceiptWidth = getReceiptWidth(),
  loaded?: LoadedReceiptSettings,
): Promise<PreparedReceipt> {
  const { settings, source, fallback } = loaded ?? (await loadReceiptSettings(qc));
  const logoSrc = receiptLogoUrl(settings, API_BASE_URL);
  const [logoDataUri, qrDataUri] = await Promise.all([
    logoSrc ? inlineImage(logoSrc) : Promise.resolve(undefined),
    inlineImage(qrImageUrl(receiptQrPayload(sale, settings))),
  ]);
  const opts = { width, logoDataUri, qrDataUri };
  const html = buildReceiptHtml(sale, settings, opts);
  const page = receiptPageSize(sale, settings, opts);
  return { html, ...page, settings, source, fallback };
}

export class ShareUnavailableError extends Error {
  constructor() {
    super("sharing unavailable");
    this.name = "ShareUnavailableError";
  }
}

/**
 * Render → PDF → share sheet. Resolves after the sheet closes. Throws
 * ShareUnavailableError when the OS has no share target (rare: iOS always
 * has one; some Android builds without a file viewer).
 */
export async function shareReceipt(
  sale: ReceiptSale,
  qc: QueryClient,
  width: ReceiptWidth = getReceiptWidth(),
  loaded?: LoadedReceiptSettings,
): Promise<PreparedReceipt> {
  if (!(await Sharing.isAvailableAsync())) throw new ShareUnavailableError();
  const prepared = await prepareReceipt(sale, qc, width, loaded);
  const { uri } = await Print.printToFileAsync({
    html: prepared.html,
    width: prepared.width,
    height: prepared.height,
    margins: { left: 0, top: 0, right: 0, bottom: 0 },
  });
  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: t("mobile.receipt.shareTitle", { invoiceId: sale.invoiceId }),
  });
  return prepared;
}

/**
 * AirPrint / Android print service. On the simulator the dialog appears with
 * no printers — that is the expected outcome, not a failure. A user-cancelled
 * dialog rejects on iOS ("Printing did not complete"); callers treat it as a
 * no-op, so it is swallowed here.
 */
export async function printReceipt(
  sale: ReceiptSale,
  qc: QueryClient,
  width: ReceiptWidth = getReceiptWidth(),
  loaded?: LoadedReceiptSettings,
): Promise<PreparedReceipt> {
  const prepared = await prepareReceipt(sale, qc, width, loaded);
  try {
    await Print.printAsync({
      html: prepared.html,
      width: prepared.width,
      height: prepared.height,
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
    });
  } catch (e) {
    if (isCancelled(e)) return prepared;
    throw e;
  }
  return prepared;
}

function isCancelled(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cancel|did not complete|dismiss/i.test(msg);
}
