"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { ProductSearchSelect } from "./ProductSearchSelect";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useBranches } from "@/hooks/useBranches";
import { recordCartSaleOfflineAware } from "@/lib/offline/recordCartSale";
import { useSales } from "@/hooks/useSales";
import { useProducts } from "@/hooks/useProducts";
import { useCustomersData } from "@/hooks/useCustomersData";
import { useShopSettings } from "@/hooks/useShopSettings";
import { buildWhatsAppLink, substitute } from "@/lib/settings";
import { sendViaGreenApi, sendViaWhatsAppCloud } from "@/lib/whatsapp";
import type { Product, DiscountType, PaymentMethod } from "@/lib/types";
import { Printer, Percent, DollarSign, Calendar, Plus, Trash2, ShoppingCart } from "@/lib/icons";
import { CustomerAutocomplete, type CustomerSuggestion } from "./CustomerAutocomplete";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { formatCurrency } from "@/lib/i18n/format";

export interface ReceiptSaleData {
  saleId?: string;
  productName: string;
  brand?: string;
  quantity: number;
  pricePerUnit: number;
  subtotal: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountAmount: number;
  totalPrice: number;
  saleDate: Date;
}

export interface ReceiptInvoiceData {
  invoiceId?: string;
  saleDate: Date;
  lines: {
    productName: string;
    brand?: string;
    quantity: number;
    pricePerUnit: number;
    subtotal: number;
    lineDiscountAmount: number;
  }[];
  cartSubtotal: number;
  orderDiscountAmount: number;
  totalPrice: number;
  /** Partial payment snapshot: amount the customer handed over at the
   *  counter. The receipt surfaces "PAID / ON ACCOUNT" lines when this is
   *  set and less than `totalPrice`. Undefined ⇒ fully paid (no extra
   *  lines printed). */
  amountPaid?: number;
  note?: string;
  /** Loyalty redemption + earn snapshot at the moment of sale. Rendered on
   *  the receipt only when the branch's `receiptShowLoyalty` is on AND at
   *  least one of these values is non-zero. */
  loyaltyPointsRedeemed?: number;
  loyaltyCreditApplied?: number;
  loyaltyPointsEarned?: number;
  loyaltyPointsBalance?: number;
  loyaltyCreditBalance?: number;
}

interface CartLineState {
  product: Product;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType: DiscountType;
  lineDiscountValue: number;
}

interface SaleFormProps {
  onSuccess: () => void;
  onPrintLastSale?: (data: ReceiptSaleData) => void;
  onPrintLastInvoice?: (data: ReceiptInvoiceData) => void;
  preselectedProduct?: Product | null;
}

function calcLineDiscount(
  qty: number,
  price: number,
  type: DiscountType,
  value: number
): number {
  const subtotal = qty * price;
  if (value <= 0) return 0;
  const raw = type === "percentage" ? Math.round((subtotal * value) / 100) : value;
  return Math.min(raw, subtotal);
}

export function SaleForm({
  onSuccess,
  onPrintLastSale: _onPrintLastSale,
  onPrintLastInvoice,
  preselectedProduct,
}: SaleFormProps) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.sales.form;
  const fmt = (n: number) => formatCurrency(n, locale);
  const fallbackName = t.customer.fallbackName;
  const { sales } = useSales();
  const { records: customerRecords } = useCustomersData();
  const { products } = useProducts();
  const { settings } = useShopSettings();
  const searchParams = useSearchParams();
  // Multi-store + offline POS: every sale carries the tenant + branch ids
  // so the outbox row can replay against the correct store even if the
  // cashier later switches branches mid-shift.
  const { data: session } = useSession();
  const tenantId = session?.user?.tenantId ?? null;
  const { current: activeBranch } = useBranches();
  const branchId = activeBranch?.id ?? null;

  // Keep the offline snapshot warm: every time the cart page loads while
  // online, refresh the IndexedDB cache from /api/pos/bootstrap. The
  // sync runs once on mount and once every 5 minutes after that. When
  // wifi blinks mid-shift, the most-recent snapshot is already on disk.
  useEffect(() => {
    if (!tenantId || !branchId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = async () => {
      if (cancelled) return;
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      try {
        const { refreshSnapshot } = await import("@/lib/offline/snapshot");
        await refreshSnapshot(tenantId, branchId);
      } catch {
        // Best-effort: a failed refresh just leaves the previous snapshot
        // in place, which is exactly what we want.
      }
    };
    void refresh();
    timer = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [tenantId, branchId]);

  // Current line being composed
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(preselectedProduct || null);
  const [quantity, setQuantity] = useState(1);
  const [pricePerUnit, setPricePerUnit] = useState(0);
  const [lineDiscountType, setLineDiscountType] = useState<DiscountType>("percentage");
  const [lineDiscountValue, setLineDiscountValue] = useState(0);

  // Cart of accumulated lines (multi-product invoice)
  const [cart, setCart] = useState<CartLineState[]>([]);

  // Order-level fields (apply to whole invoice)
  const [note, setNote] = useState("");
  const [orderDiscountType, setOrderDiscountType] = useState<DiscountType>("percentage");
  const [orderDiscountValue, setOrderDiscountValue] = useState(0);
  const [useCustomDate, setUseCustomDate] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);
  const [customDate, setCustomDate] = useState(todayStr);

  // Customer + payment
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  /** For deferred sales only: amount the customer paid at the counter. Stored
   *  as a string so the input can be edited fluently (empty, "0", "0.50",
   *  etc.) — parsed to a number at submit. */
  const [amountPaidNowInput, setAmountPaidNowInput] = useState("");

  // Loyalty redemption — appears only when the active branch's loyalty
  // programme is enabled AND the cashier has typed a customer phone.
  const [walletPoints, setWalletPoints] = useState(0);
  const [walletCredit, setWalletCredit] = useState(0);
  const [redeemPointsInput, setRedeemPointsInput] = useState("");
  const [applyCreditInput, setApplyCreditInput] = useState("");
  useEffect(() => {
    if (!settings.loyaltyEnabled || !customerPhone.trim()) {
      setWalletPoints(0);
      setWalletCredit(0);
      return;
    }
    const phone = customerPhone.trim();
    let cancelled = false;
    // 400ms debounce so a fast typist doesn't spam the wallet endpoint.
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/customers/by-phone/${encodeURIComponent(phone)}/wallet`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (!res.ok) {
          setWalletPoints(0);
          setWalletCredit(0);
          return;
        }
        const json = (await res.json()) as {
          wallet: { points: number; credit: number };
        };
        setWalletPoints(json.wallet.points);
        setWalletCredit(json.wallet.credit);
      } catch {
        if (!cancelled) {
          setWalletPoints(0);
          setWalletCredit(0);
        }
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [customerPhone, settings.loyaltyEnabled]);

  // Reset redemption inputs when the customer changes (otherwise a
  // previous customer's "redeem 50 pts" would silently apply to next sale).
  useEffect(() => {
    setRedeemPointsInput("");
    setApplyCreditInput("");
  }, [customerPhone]);

  const [loading, setLoading] = useState(false);

  // Last invoice for receipt
  const [lastInvoice, setLastInvoice] = useState<ReceiptInvoiceData | null>(null);

  useEffect(() => {
    if (selectedProduct) {
      setPricePerUnit(selectedProduct.price);
    }
  }, [selectedProduct]);

  // Pre-select a product via ?preselect=<id> (used by inventory's quick-sell)
  useEffect(() => {
    const id = searchParams.get("preselect");
    if (!id) return;
    const p = products.find((x) => x.id === id);
    if (p) {
      setSelectedProduct(p);
    }
    // Strip the query from the URL so refresh doesn't re-trigger
    const url = new URL(window.location.href);
    url.searchParams.delete("preselect");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (e.key === "/" && !isTyping) {
        e.preventDefault();
        document.getElementById("sale-product-search")?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Build a list of past customers (phone-keyed) for autocomplete.
  // Uses useCustomersData (direct Firestore read) so it always sees
  // customerName/customerPhone fields, regardless of any chunk caching.
  const pastCustomers: CustomerSuggestion[] = (() => {
    const map = new Map<
      string,
      {
        name: string;
        phone: string;
        lastVisit: number;
        invoiceIds: Set<string>;
        lifetimeValue: number;
      }
    >();
    for (const s of customerRecords) {
      if (s.isReturned) continue;
      const name = (s.customerName || "").trim();
      const phone = (s.customerPhone || "").trim();
      if (!name && !phone) continue;
      const key = phone || `name:${name.toLowerCase()}`;
      const cur =
        map.get(key) || {
          name,
          phone,
          lastVisit: s.saleDate.getTime(),
          invoiceIds: new Set<string>(),
          lifetimeValue: 0,
        };
      cur.lifetimeValue += s.totalPrice;
      if (s.invoiceId) cur.invoiceIds.add(s.invoiceId);
      const ts = s.saleDate.getTime();
      if (ts > cur.lastVisit) cur.lastVisit = ts;
      if (name && !cur.name) cur.name = name;
      if (phone && !cur.phone) cur.phone = phone;
      map.set(key, cur);
    }
    return Array.from(map.values())
      .map((v) => ({
        name: v.name,
        phone: v.phone,
        invoiceCount: v.invoiceIds.size,
        lifetimeValue: v.lifetimeValue,
      }))
      .sort((a, b) => (b.lifetimeValue || 0) - (a.lifetimeValue || 0));
  })();

  const handleCustomerPick = (entry: CustomerSuggestion) => {
    if (entry.name) setCustomerName(entry.name);
    if (entry.phone) setCustomerPhone(entry.phone);
  };

  const recentProducts = (() => {
    const seen = new Set<string>();
    const out: Product[] = [];
    for (const s of sales) {
      if (out.length >= 5) break;
      if (seen.has(s.productId)) continue;
      seen.add(s.productId);
      const p = products.find((x) => x.id === s.productId);
      if (p && p.quantity > 0) out.push(p);
    }
    return out;
  })();

  // Include the in-progress line (selected product + qty/price) in the live preview
  // so users see totals before clicking "Add to cart".
  const previewLines: CartLineState[] = (() => {
    if (!selectedProduct || quantity < 1 || pricePerUnit <= 0) return cart;
    return [
      ...cart,
      {
        product: selectedProduct,
        quantity,
        pricePerUnit,
        lineDiscountType,
        lineDiscountValue,
      },
    ];
  })();

  const cartSubtotalGross = previewLines.reduce(
    (s, l) => s + l.quantity * l.pricePerUnit,
    0
  );
  const cartLineDiscountTotal = previewLines.reduce(
    (s, l) =>
      s +
      calcLineDiscount(
        l.quantity,
        l.pricePerUnit,
        l.lineDiscountType,
        l.lineDiscountValue
      ),
    0
  );
  const cartAfterLines = cartSubtotalGross - cartLineDiscountTotal;
  const orderDiscountAmount =
    orderDiscountValue > 0 && cartAfterLines > 0
      ? Math.min(
          orderDiscountType === "percentage"
            ? Math.round((cartAfterLines * orderDiscountValue) / 100)
            : orderDiscountValue,
          cartAfterLines
        )
      : 0;
  const cartAfterOrderDiscount = cartAfterLines - orderDiscountAmount;

  // ── Loyalty redemption preview ─────────────────────────────────────
  // Live-recompute the discount as the cashier types in the redeem fields.
  // Mirrors the server-side cap-and-trim logic in `recordCartSale`: if the
  // requested redemption exceeds what's left after the order discount, we
  // shrink it (preserve credit, trim points) so the displayed total
  // matches what the server will actually book. The cashier sees the
  // EXACT final number before submitting.
  const requestedRedeemPoints = Math.max(
    0,
    Math.floor(Number(redeemPointsInput) || 0),
  );
  const requestedApplyCredit = Math.max(0, Number(applyCreditInput) || 0);
  const cappedRedeemPoints = Math.min(requestedRedeemPoints, walletPoints);
  const cappedApplyCredit = Math.min(requestedApplyCredit, walletCredit);

  let loyaltyDiscountAmount = 0;
  let loyaltyPointsAppliedDisplay = 0;
  let loyaltyCreditAppliedDisplay = 0;
  if (cappedRedeemPoints > 0 || cappedApplyCredit > 0) {
    const rate = settings.loyaltyEgpPerPoint || 0;
    const pointsValue = Math.round(cappedRedeemPoints * rate * 100) / 100;
    let total = pointsValue + cappedApplyCredit;
    if (total > cartAfterOrderDiscount) {
      // Trim to the available headroom: keep credit, cut points first.
      total = cartAfterOrderDiscount;
      if (cappedApplyCredit >= cartAfterOrderDiscount) {
        loyaltyCreditAppliedDisplay = cartAfterOrderDiscount;
        loyaltyPointsAppliedDisplay = 0;
      } else {
        loyaltyCreditAppliedDisplay = cappedApplyCredit;
        const fromPoints = cartAfterOrderDiscount - cappedApplyCredit;
        loyaltyPointsAppliedDisplay =
          rate > 0 ? Math.floor(fromPoints / rate) : 0;
      }
      loyaltyDiscountAmount =
        Math.round(loyaltyPointsAppliedDisplay * rate * 100) / 100 +
        loyaltyCreditAppliedDisplay;
    } else {
      loyaltyDiscountAmount = total;
      loyaltyPointsAppliedDisplay = cappedRedeemPoints;
      loyaltyCreditAppliedDisplay = cappedApplyCredit;
    }
  }

  const cartTotal = Math.max(0, cartAfterOrderDiscount - loyaltyDiscountAmount);

  // Inventory check: account for the cart already holding some quantity of this product
  const stockReservedFor = (productId: string) =>
    cart
      .filter((l) => l.product.id === productId)
      .reduce((s, l) => s + l.quantity, 0);

  const remainingStockForCurrent = selectedProduct
    ? selectedProduct.quantity - stockReservedFor(selectedProduct.id)
    : 0;

  const canAddCurrentLine =
    !!selectedProduct &&
    quantity >= 1 &&
    pricePerUnit >= 1 &&
    quantity <= remainingStockForCurrent;

  const handleAddToCart = () => {
    if (!canAddCurrentLine || !selectedProduct) return;
    setCart((prev) => [
      ...prev,
      {
        product: selectedProduct,
        quantity,
        pricePerUnit,
        lineDiscountType,
        lineDiscountValue,
      },
    ]);
    setSelectedProduct(null);
    setQuantity(1);
    setPricePerUnit(0);
    setLineDiscountValue(0);
  };

  const handleRemoveLine = (idx: number) => {
    setCart((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    // Auto-add the current in-progress line to the cart if any
    let lines: CartLineState[] = cart;
    if (selectedProduct && quantity >= 1 && pricePerUnit >= 1 && canAddCurrentLine) {
      lines = [
        ...cart,
        {
          product: selectedProduct,
          quantity,
          pricePerUnit,
          lineDiscountType,
          lineDiscountValue,
        },
      ];
    }
    if (lines.length === 0) return;

    let saleDate: Date = new Date();
    if (useCustomDate && customDate) {
      const parsed = new Date(`${customDate}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) {
        alert(t.errors.invalidDate);
        return;
      }
      if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
        alert(t.errors.futureDate);
        return;
      }
      saleDate = parsed;
    }

    if (!tenantId || !branchId) {
      alert(t.errors.sessionMissing);
      return;
    }

    setLoading(true);
    try {
      const result = await recordCartSaleOfflineAware(
        { tenantId, branchId },
        lines.map((l) => ({
          productId: l.product.id,
          quantity: l.quantity,
          pricePerUnit: l.pricePerUnit,
          lineDiscountType: l.lineDiscountValue > 0 ? l.lineDiscountType : undefined,
          lineDiscountValue: l.lineDiscountValue > 0 ? l.lineDiscountValue : undefined,
        })),
        {
          note: note || undefined,
          orderDiscountType: orderDiscountValue > 0 ? orderDiscountType : undefined,
          orderDiscountValue: orderDiscountValue > 0 ? orderDiscountValue : undefined,
          customDate: useCustomDate ? saleDate : undefined,
          customerName: customerName.trim() || undefined,
          customerPhone: customerPhone.trim() || undefined,
          paymentMethod,
          // Loyalty redemption — server validates against current wallet
          // and refuses if balance is short or programme is disabled.
          redeemPoints: Math.max(0, Math.floor(Number(redeemPointsInput) || 0)),
          applyCreditEgp: Math.max(0, Number(applyCreditInput) || 0),
          // Partial payment on آجل: how much the customer handed over now.
          // Server clamps to [0, finalTotal]. Sending 0 (the default) keeps
          // the simple "full receipt on account" flow working as before.
          amountPaidNow:
            paymentMethod === "deferred"
              ? Math.max(0, Number(amountPaidNowInput) || 0)
              : undefined,
        }
      );

      const linesGross = lines.reduce(
        (s, l) => s + l.quantity * l.pricePerUnit,
        0
      );
      const lineDiscTotal = lines.reduce(
        (s, l) =>
          s +
          calcLineDiscount(
            l.quantity,
            l.pricePerUnit,
            l.lineDiscountType,
            l.lineDiscountValue
          ),
        0
      );
      const after = linesGross - lineDiscTotal;
      const orderDisc =
        orderDiscountValue > 0 && after > 0
          ? Math.min(
              orderDiscountType === "percentage"
                ? Math.round((after * orderDiscountValue) / 100)
                : orderDiscountValue,
              after
            )
          : 0;
      const total = after - orderDisc;

      // Loyalty snapshot for the printed receipt — mirror the same cap-and-trim
      // logic the server applied so what we print matches what was committed.
      // pointsEarned uses the FINAL paid amount (after redemption), matching
      // recordCartSale's earnPoints call.
      const earnRate = settings.loyaltyEnabled
        ? settings.loyaltyPointsPerEgp || 0
        : 0;
      const paidTotal = Math.max(0, total - loyaltyDiscountAmount);
      const pointsEarned =
        settings.loyaltyEnabled && earnRate > 0
          ? Math.floor(paidTotal * earnRate)
          : 0;
      const finalPoints = Math.max(
        0,
        walletPoints - loyaltyPointsAppliedDisplay + pointsEarned,
      );
      const finalCredit = Math.max(0, walletCredit - loyaltyCreditAppliedDisplay);

      const invoiceForReceipt: ReceiptInvoiceData = {
        invoiceId: result.invoiceId,
        saleDate,
        lines: lines.map((l) => ({
          productName: l.product.name,
          brand: l.product.brand,
          quantity: l.quantity,
          pricePerUnit: l.pricePerUnit,
          subtotal: l.quantity * l.pricePerUnit,
          lineDiscountAmount: calcLineDiscount(
            l.quantity,
            l.pricePerUnit,
            l.lineDiscountType,
            l.lineDiscountValue
          ),
        })),
        cartSubtotal: linesGross,
        orderDiscountAmount: orderDisc,
        // The actual paid amount — receipt's TOTAL line should match what
        // the customer handed over, post-loyalty. Pre-loyalty subtotal
        // still appears above as SUBTOTAL so the math reads correctly.
        totalPrice: paidTotal,
        // Partial-payment IOU lines on the receipt. We pass undefined on
        // non-deferred sales (or fully-paid deferred ones) so the receipt
        // stays clean. The clamp matches the server's invariant.
        amountPaid:
          paymentMethod === "deferred"
            ? Math.max(
                0,
                Math.min(Number(amountPaidNowInput) || 0, paidTotal),
              )
            : undefined,
        note: note || undefined,
        loyaltyPointsRedeemed: loyaltyPointsAppliedDisplay || undefined,
        loyaltyCreditApplied: loyaltyCreditAppliedDisplay || undefined,
        loyaltyPointsEarned: pointsEarned || undefined,
        loyaltyPointsBalance: customerPhone.trim() ? finalPoints : undefined,
        loyaltyCreditBalance: customerPhone.trim() ? finalCredit : undefined,
      };
      setLastInvoice(invoiceForReceipt);

      // After-sale WhatsApp delivery.
      // Rule: when any auto-send provider is enabled (Cloud API or Green API),
      // NEVER open a wa.me tab — those toggles are hard kill-switches. wa.me
      // only fires when both providers are off AND autoOpenWhatsApp is on.
      // When both providers are configured, Cloud API wins (it's the official
      // channel and doesn't risk number bans).
      const trimmedPhone = customerPhone.trim();
      if (trimmedPhone && result.saleIds.length > 0) {
        // Receipts are sent as PDF attachments in v1 — no public web URL.
        // The {{receiptLink}} substitution is kept for template compatibility
        // but always resolves to "" so the line drops out of the message.
        const receiptLink = "";
        const message = substitute(settings.messageTemplate, {
          customerName: customerName.trim() || fallbackName,
          customerPhone: trimmedPhone,
          invoiceId: result.invoiceId,
          invoiceCode: result.invoiceId.slice(-8).toUpperCase(),
          totalPrice: fmt(total),
          productNames: lines.map((l) => l.product.name).join("، "),
          receiptLink,
          date: saleDate.toLocaleDateString(
            locale === "en" ? "en-EG" : "ar-EG",
            { numberingSystem: "latn" } as Intl.DateTimeFormatOptions,
          ),
          shopName: settings.shopName,
          shopPhone: settings.shopPhone,
        });

        // Cloud API takes priority over Green API.
        const useCloud =
          settings.whatsappCloudEnabled &&
          !!settings.whatsappCloudPhoneId &&
          !!settings.whatsappCloudToken;
        const useGreen =
          !useCloud &&
          settings.greenApiEnabled &&
          !!settings.greenApiInstanceId &&
          !!settings.greenApiToken;

        // Phase 6: receipt-template path takes priority over PDF when
        // configured. Bypasses Meta's 24-hour window and renders
        // natively in WhatsApp instead of as an attachment.
        const useReceiptTemplate =
          useCloud &&
          !!settings.receiptTemplateName &&
          !!settings.receiptTemplateLanguage;

        if (useReceiptTemplate) {
          const productNames = lines
            .map((l) => l.product.name)
            .join("، ")
            .slice(0, 1024);
          fetch("/api/whatsapp/cloud/send-template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phone: trimmedPhone,
              templateName: settings.receiptTemplateName,
              language: settings.receiptTemplateLanguage,
              components: [
                {
                  type: "body",
                  parameters: [
                    {
                      type: "text",
                      text: customerName.trim() || fallbackName,
                    },
                    {
                      type: "text",
                      text: result.invoiceId.slice(-8).toUpperCase(),
                    },
                    { type: "text", text: fmt(total) },
                    { type: "text", text: productNames },
                  ],
                },
              ],
            }),
          })
            .then((r) => r.json())
            .then((res) => {
              if (res?.ok) {
                console.log(
                  "[whatsapp] receipt template sent",
                  res.clientMessageId,
                );
              } else {
                console.warn("[whatsapp] receipt template failed", res);
              }
            })
            .catch((e) =>
              console.warn("[whatsapp] receipt template network error", e),
            );
        } else if (useCloud) {
          // PDF caption builder — same logic as the Green API branch.
          const buildCaption = () =>
            substitute(settings.messageTemplate, {
              customerName: customerName.trim() || fallbackName,
              customerPhone: trimmedPhone,
              invoiceId: result.invoiceId,
              invoiceCode: result.invoiceId.slice(-8).toUpperCase(),
              totalPrice: fmt(total),
              productNames: lines.map((l) => l.product.name).join("، "),
              receiptLink: "",
              date: saleDate.toLocaleDateString(
                locale === "en" ? "en-EG" : "ar-EG",
                { numberingSystem: "latn" } as Intl.DateTimeFormatOptions,
              ),
              shopName: settings.shopName,
              shopPhone: settings.shopPhone,
            })
              .split("\n")
              .filter((line) => {
                const t = line.trim();
                if (/^رابط الفاتورة:\s*$/.test(t)) return false;
                if (/^receipt link:\s*$/i.test(t)) return false;
                return true;
              })
              .join("\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();

          if (settings.sendAsPdf) {
            const invoicePayload = {
              invoiceId: result.invoiceId,
              saleDate: saleDate.toISOString(),
              customerName: customerName.trim() || undefined,
              customerPhone: trimmedPhone,
              lines: lines.map((l) => ({
                productName: l.product.name,
                brand: l.product.brand,
                quantity: l.quantity,
                pricePerUnit: l.pricePerUnit,
                subtotal: l.quantity * l.pricePerUnit,
                lineDiscountAmount: calcLineDiscount(
                  l.quantity,
                  l.pricePerUnit,
                  l.lineDiscountType,
                  l.lineDiscountValue
                ),
              })),
              cartSubtotal: cartSubtotalGross,
              orderDiscountAmount,
              totalPrice: total,
              note: note || undefined,
              shopName: settings.shopName,
              shopPhone: settings.shopPhone,
            };
            fetch("/api/whatsapp/cloud/send-pdf", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                phone: trimmedPhone,
                caption: buildCaption(),
                invoice: invoicePayload,
              }),
            })
              .then((r) => r.json())
              .then((res) => {
                if (res?.ok) {
                  console.log("[whatsapp] Cloud PDF sent", res.idMessage);
                } else {
                  console.warn("[whatsapp] Cloud PDF send failed", res);
                }
              })
              .catch((e) =>
                console.warn("[whatsapp] Cloud PDF send network error", e)
              );
          } else {
            sendViaWhatsAppCloud({
              phone: trimmedPhone,
              message,
            }).then((res) => {
              if (res.ok) {
                console.log("[whatsapp] Cloud API sent", res.idMessage);
              } else {
                console.warn("[whatsapp] Cloud API send failed", res);
              }
            });
          }
        } else if (settings.whatsappCloudEnabled && !useCloud) {
          console.warn(
            "[whatsapp] Cloud API enabled but credentials missing — skipping send (no tab opened)"
          );
        } else if (settings.greenApiEnabled) {
          // Hard kill-switch: never open a tab when this toggle is on.
          if (!useGreen) {
            console.warn(
              "[whatsapp] Green API enabled but credentials missing — skipping send (no tab opened)"
            );
          } else if (settings.sendAsPdf) {
            // PDF mode: build a clean caption WITHOUT the receipt link
            // (the customer is getting the PDF itself, no link needed).
            const captionRaw = substitute(settings.messageTemplate, {
              customerName: customerName.trim() || fallbackName,
              customerPhone: trimmedPhone,
              invoiceId: result.invoiceId,
              invoiceCode: result.invoiceId.slice(-8).toUpperCase(),
              totalPrice: fmt(total),
              productNames: lines.map((l) => l.product.name).join("، "),
              receiptLink: "",
              date: saleDate.toLocaleDateString(
                locale === "en" ? "en-EG" : "ar-EG",
                { numberingSystem: "latn" } as Intl.DateTimeFormatOptions,
              ),
              shopName: settings.shopName,
              shopPhone: settings.shopPhone,
            });
            const pdfCaption = captionRaw
              .split("\n")
              .filter((line) => {
                const t = line.trim();
                if (/^رابط الفاتورة:\s*$/.test(t)) return false;
                if (/^receipt link:\s*$/i.test(t)) return false;
                return true;
              })
              .join("\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            // Send as PDF attachment via Green API sendFileByUpload
            const invoicePayload = {
              invoiceId: result.invoiceId,
              saleDate: saleDate.toISOString(),
              customerName: customerName.trim() || undefined,
              customerPhone: trimmedPhone,
              lines: lines.map((l) => ({
                productName: l.product.name,
                brand: l.product.brand,
                quantity: l.quantity,
                pricePerUnit: l.pricePerUnit,
                subtotal: l.quantity * l.pricePerUnit,
                lineDiscountAmount: calcLineDiscount(
                  l.quantity,
                  l.pricePerUnit,
                  l.lineDiscountType,
                  l.lineDiscountValue
                ),
              })),
              cartSubtotal: cartSubtotalGross,
              orderDiscountAmount,
              totalPrice: total,
              note: note || undefined,
              shopName: settings.shopName,
              shopPhone: settings.shopPhone,
            };
            fetch("/api/whatsapp/send-pdf", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                phone: trimmedPhone,
                caption: pdfCaption,
                invoice: invoicePayload,
              }),
            })
              .then((r) => r.json())
              .then((res) => {
                if (res?.ok) {
                  console.log("[whatsapp] PDF sent", res.idMessage);
                } else {
                  console.warn("[whatsapp] PDF send failed", res);
                }
              })
              .catch((e) => console.warn("[whatsapp] PDF send network error", e));
          } else {
            sendViaGreenApi({
              phone: trimmedPhone,
              message,
            }).then((res) => {
              if (res.ok) {
                console.log("[whatsapp] Green API sent", res.idMessage);
              } else {
                console.warn("[whatsapp] Green API send failed", res);
              }
            });
          }
        } else if (settings.autoOpenWhatsApp) {
          const url = buildWhatsAppLink(trimmedPhone, message);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        }
      }

      // Reset form
      setCart([]);
      setSelectedProduct(null);
      setQuantity(1);
      setPricePerUnit(0);
      setLineDiscountValue(0);
      setOrderDiscountValue(0);
      setNote("");
      setUseCustomDate(false);
      setCustomDate(new Date().toISOString().slice(0, 10));
      setCustomerName("");
      setCustomerPhone("");
      setPaymentMethod("cash");
      setAmountPaidNowInput("");
      onSuccess();
    } catch (error: any) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    if (lastInvoice && onPrintLastInvoice) {
      onPrintLastInvoice(lastInvoice);
    }
  };

  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-border">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">{t.title}</h3>
        {cart.length > 0 && (
          <span className="text-xs px-2 py-1 rounded-full bg-accent-light text-accent font-medium">
            {t.itemsInCart.replace("{n}", String(cart.length))}
          </span>
        )}
      </div>

      <div className="space-y-4">
        <ProductSearchSelect value={selectedProduct} onChange={setSelectedProduct} />

        {!selectedProduct && cart.length === 0 && recentProducts.length > 0 && (
          <div>
            <p className="text-xs text-text-secondary mb-2">{t.recentLabel}</p>
            <div className="flex flex-wrap gap-2">
              {recentProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProduct(p)}
                  className="px-3 py-1.5 rounded-full text-xs bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {selectedProduct && (
          <div className="space-y-3 p-3 rounded-lg border border-border">
            <p className="text-sm text-text-secondary">
              {t.available.replace("{n}", String(remainingStockForCurrent))}
            </p>

            <Input
              label={t.fields.quantity}
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              min={1}
              max={remainingStockForCurrent}
              error={
                quantity > remainingStockForCurrent
                  ? t.fields.maxQuantity.replace("{n}", String(remainingStockForCurrent))
                  : undefined
              }
            />

            <Input
              label={t.fields.pricePerUnit}
              type="number"
              value={pricePerUnit}
              onChange={(e) => setPricePerUnit(Number(e.target.value))}
              min={1}
            />

            <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <p className="text-xs font-medium text-text-secondary">{t.fields.lineDiscount}</p>
              <div className="flex rounded-lg overflow-hidden border border-border">
                <button
                  type="button"
                  onClick={() => setLineDiscountType("percentage")}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs ${
                    lineDiscountType === "percentage"
                      ? "bg-accent text-white"
                      : "bg-white text-text-secondary"
                  }`}
                >
                  <Percent className="w-3 h-3" />
                  {t.fields.percent}
                </button>
                <button
                  type="button"
                  onClick={() => setLineDiscountType("fixed")}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs ${
                    lineDiscountType === "fixed"
                      ? "bg-accent text-white"
                      : "bg-white text-text-secondary"
                  }`}
                >
                  <DollarSign className="w-3 h-3" />
                  {t.fields.amount}
                </button>
              </div>
              <Input
                label={lineDiscountType === "percentage" ? t.fields.discountPercent : t.fields.discountAmount}
                type="number"
                value={lineDiscountValue}
                onChange={(e) => setLineDiscountValue(Number(e.target.value))}
                min={0}
                max={lineDiscountType === "percentage" ? 100 : quantity * pricePerUnit}
              />
            </div>

            <button
              type="button"
              onClick={handleAddToCart}
              disabled={!canAddCurrentLine}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-accent-light text-accent hover:bg-accent hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              {t.addToCart}
            </button>
          </div>
        )}

        {/* Cart lines */}
        {cart.length > 0 && (
          <div className="border border-border rounded-lg divide-y divide-border">
            {cart.map((line, idx) => {
              const lineSubtotal = line.quantity * line.pricePerUnit;
              const ld = calcLineDiscount(
                line.quantity,
                line.pricePerUnit,
                line.lineDiscountType,
                line.lineDiscountValue
              );
              return (
                <div key={idx} className="flex items-center gap-2 p-3 text-sm">
                  <ShoppingCart className="w-4 h-4 text-text-secondary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate" dir="auto">{line.product.name}</p>
                    <p className="text-xs text-text-secondary">
                      {line.quantity} × {fmt(line.pricePerUnit)}
                      {ld > 0 && (
                        <span className="text-danger ms-1">
                          {t.lineDiscountInline.replace("{amount}", fmt(ld))}
                        </span>
                      )}
                    </p>
                  </div>
                  <span className="font-bold whitespace-nowrap">
                    {fmt(lineSubtotal - ld)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveLine(idx)}
                    className="p-1 text-danger hover:bg-danger-light rounded"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Order-level fields shown once any line exists */}
        {(cart.length > 0 || selectedProduct) && (
          <>
            <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <p className="text-sm font-medium text-text-secondary">
                {t.orderDiscount}
              </p>
              <div className="flex rounded-lg overflow-hidden border border-border">
                <button
                  type="button"
                  onClick={() => setOrderDiscountType("percentage")}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs ${
                    orderDiscountType === "percentage"
                      ? "bg-accent text-white"
                      : "bg-white text-text-secondary"
                  }`}
                >
                  <Percent className="w-3 h-3" />
                  {t.fields.percent}
                </button>
                <button
                  type="button"
                  onClick={() => setOrderDiscountType("fixed")}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs ${
                    orderDiscountType === "fixed"
                      ? "bg-accent text-white"
                      : "bg-white text-text-secondary"
                  }`}
                >
                  <DollarSign className="w-3 h-3" />
                  {t.fields.amount}
                </button>
              </div>
              <Input
                label={orderDiscountType === "percentage" ? t.fields.discountPercent : t.fields.discountAmount}
                type="number"
                value={orderDiscountValue}
                onChange={(e) => setOrderDiscountValue(Number(e.target.value))}
                min={0}
                max={orderDiscountType === "percentage" ? 100 : cartAfterLines}
              />
            </div>

            {/* Totals preview */}
            <div className="p-4 bg-accent-light rounded-lg space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">{t.totals.subtotal}</span>
                <span>{fmt(cartSubtotalGross)}</span>
              </div>
              {cartLineDiscountTotal > 0 && (
                <div className="flex justify-between text-danger">
                  <span>{t.totals.lineDiscounts}</span>
                  <span>- {fmt(cartLineDiscountTotal)}</span>
                </div>
              )}
              {orderDiscountAmount > 0 && (
                <div className="flex justify-between text-danger">
                  <span>{t.totals.orderDiscount}</span>
                  <span>- {fmt(orderDiscountAmount)}</span>
                </div>
              )}
              {loyaltyPointsAppliedDisplay > 0 && (
                <div className="flex justify-between text-orange-600">
                  <span>
                    {t.totals.loyaltyPoints.replace(
                      "{n}",
                      String(loyaltyPointsAppliedDisplay),
                    )}
                  </span>
                  <span>
                    -{" "}
                    {fmt(
                      Math.round(
                        loyaltyPointsAppliedDisplay *
                          (settings.loyaltyEgpPerPoint || 0) *
                          100,
                      ) / 100,
                    )}
                  </span>
                </div>
              )}
              {loyaltyCreditAppliedDisplay > 0 && (
                <div className="flex justify-between text-success">
                  <span>{t.totals.loyaltyCredit}</span>
                  <span>- {fmt(loyaltyCreditAppliedDisplay)}</span>
                </div>
              )}
              <div className="border-t border-accent/20 pt-1 flex justify-between font-bold">
                <span>{t.totals.total}</span>
                <span className="text-2xl text-accent">{fmt(cartTotal)}</span>
              </div>
              {loyaltyDiscountAmount > 0 &&
                (requestedRedeemPoints > cappedRedeemPoints ||
                  requestedApplyCredit > cappedApplyCredit ||
                  requestedRedeemPoints * (settings.loyaltyEgpPerPoint || 0) +
                    requestedApplyCredit >
                    cartAfterOrderDiscount) && (
                  <p className="text-[11px] text-orange-700 leading-relaxed pt-1">
                    {t.totals.loyaltyTrimmedNote}
                  </p>
                )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <CustomerAutocomplete
                field="name"
                label={t.customer.nameLabel}
                placeholder={t.customer.namePlaceholder}
                value={customerName}
                onChange={setCustomerName}
                onPick={handleCustomerPick}
                suggestions={pastCustomers}
              />
              <CustomerAutocomplete
                field="phone"
                label={t.customer.phoneLabel}
                placeholder={t.customer.phonePlaceholder}
                value={customerPhone}
                onChange={setCustomerPhone}
                onPick={handleCustomerPick}
                suggestions={pastCustomers}
              />
            </div>

            {/* Loyalty redemption — appears only when programme is enabled
                AND a customer phone has been entered. Shows current
                balances + two inputs to redeem points / apply credit. */}
            {settings.loyaltyEnabled && customerPhone.trim() && (
              <div className="rounded-xl border border-accent-light bg-accent-light/30 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-text-primary">
                    {t.loyalty.walletLabel}
                  </span>
                  <div className="flex items-center gap-3 tabular-nums">
                    <span>
                      <b className="text-orange-600">{walletPoints}</b> {t.loyalty.pointsSuffix}
                      {walletPoints > 0 && settings.loyaltyEgpPerPoint > 0 && (
                        <span className="text-text-secondary">
                          {" "}
                          (={" "}
                          {fmt(walletPoints * settings.loyaltyEgpPerPoint)}
                          )
                        </span>
                      )}
                    </span>
                    <span className="text-text-secondary">·</span>
                    <span>
                      <b className="text-success">
                        {fmt(walletCredit)}
                      </b>{" "}
                      {t.loyalty.creditSuffix}
                    </span>
                  </div>
                </div>
                {(walletPoints > 0 || walletCredit > 0) && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-text-secondary mb-0.5">
                        {t.loyalty.redeemPoints}
                      </label>
                      <input
                        type="number"
                        min="0"
                        max={walletPoints}
                        step="1"
                        value={redeemPointsInput}
                        onChange={(e) => setRedeemPointsInput(e.target.value)}
                        placeholder="0"
                        className="w-full px-2.5 py-1.5 rounded-md border border-border text-sm focus:outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-text-secondary mb-0.5">
                        {t.loyalty.applyCredit}
                      </label>
                      <input
                        type="number"
                        min="0"
                        max={walletCredit}
                        step="0.01"
                        value={applyCreditInput}
                        onChange={(e) => setApplyCreditInput(e.target.value)}
                        placeholder="0"
                        className="w-full px-2.5 py-1.5 rounded-md border border-border text-sm focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                {t.payment.label}
              </label>
              <div className="grid grid-cols-4 gap-1 rounded-lg overflow-hidden border border-border">
                {(["cash", "instapay", "card", "deferred"] as PaymentMethod[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPaymentMethod(m)}
                    className={`py-2 text-xs font-medium ${
                      paymentMethod === m
                        ? m === "deferred"
                          ? "bg-orange-500 text-white"
                          : "bg-accent text-white"
                        : "bg-white text-text-secondary"
                    }`}
                  >
                    {dict.app.catalog.payment[m]}
                  </button>
                ))}
              </div>
              {paymentMethod === "deferred" && (
                <div className="mt-2 rounded-lg border border-orange-200 bg-orange-50/60 p-3 space-y-2">
                  <p className="text-xs text-orange-700 leading-relaxed">
                    {t.payment.deferredNote}
                  </p>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-text-secondary shrink-0">
                      {t.payment.partialPaidNow}
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={cartTotal}
                      step="0.01"
                      inputMode="decimal"
                      value={amountPaidNowInput}
                      onChange={(e) => setAmountPaidNowInput(e.target.value)}
                      placeholder="0"
                      dir="ltr"
                      className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-orange-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                    />
                    <button
                      type="button"
                      onClick={() => setAmountPaidNowInput(String(cartTotal))}
                      className="shrink-0 text-[11px] font-semibold text-accent hover:underline"
                    >
                      {t.payment.partialPayAll}
                    </button>
                  </div>
                  {(() => {
                    const paidNow = Math.max(
                      0,
                      Math.min(Number(amountPaidNowInput) || 0, cartTotal),
                    );
                    const balance = Math.max(0, cartTotal - paidNow);
                    return (
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-text-secondary">
                          {t.payment.partialPaidLabel}: {fmt(paidNow)}
                        </span>
                        <span
                          className={`font-semibold ${
                            balance > 0 ? "text-orange-700" : "text-success"
                          }`}
                        >
                          {t.payment.partialBalanceLabel}: {fmt(balance)}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            <Input
              label={t.note.label}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t.note.placeholder}
            />

            <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useCustomDate}
                  onChange={(e) => setUseCustomDate(e.target.checked)}
                  className="w-4 h-4 accent-accent"
                />
                <Calendar className="w-4 h-4 text-text-secondary" />
                <span className="text-sm font-medium text-text-secondary">
                  {t.backdate.label}
                </span>
              </label>
              {useCustomDate && (
                <input
                  type="date"
                  value={customDate}
                  max={todayStr}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm"
                />
              )}
            </div>

            <Button
              onClick={handleSubmit}
              disabled={loading || (cart.length === 0 && !canAddCurrentLine)}
              loading={loading}
              className="w-full"
            >
              {t.submit}
            </Button>
          </>
        )}
      </div>

      {/* Print last invoice */}
      {lastInvoice && (
        <div className="mt-4 pt-4 border-t border-border">
          <Button
            variant="secondary"
            onClick={handlePrint}
            className="w-full flex items-center justify-center gap-2"
          >
            <Printer className="w-5 h-5" />
            {t.printInvoice}
          </Button>
        </div>
      )}
    </div>
  );
}
