"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ProductSearchSelect } from "./ProductSearchSelect";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { recordCartSale } from "@/lib/api/sales";
import { useSales } from "@/hooks/useSales";
import { useProducts } from "@/hooks/useProducts";
import { useCustomersData } from "@/hooks/useCustomersData";
import { useShopSettings } from "@/hooks/useShopSettings";
import { buildWhatsAppLink, substitute } from "@/lib/settings";
import { sendViaGreenApi } from "@/lib/whatsapp";
import type { Product, DiscountType, PaymentMethod } from "@/lib/types";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { formatPrice } from "@/lib/utils";
import { Printer, Percent, DollarSign, Calendar, Plus, Trash2, ShoppingCart } from "@/lib/icons";
import { CustomerAutocomplete, type CustomerSuggestion } from "./CustomerAutocomplete";

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
  note?: string;
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
  const { sales } = useSales();
  const { records: customerRecords } = useCustomersData();
  const { products } = useProducts();
  const { settings } = useShopSettings();
  const searchParams = useSearchParams();

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
  // so users see totals before clicking "إضافة للفاتورة".
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
  const cartTotal = cartAfterLines - orderDiscountAmount;

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
        alert("تاريخ غير صحيح");
        return;
      }
      if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
        alert("لا يمكن تسجيل بيع في تاريخ مستقبلي");
        return;
      }
      saleDate = parsed;
    }

    setLoading(true);
    try {
      const result = await recordCartSale(
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
        totalPrice: total,
        note: note || undefined,
      };
      setLastInvoice(invoiceForReceipt);

      // After-sale WhatsApp delivery.
      // Rule: when greenApiEnabled is true, NEVER open a wa.me tab — the
      // toggle is a hard kill-switch. If the API call fails, log it and
      // give up silently. wa.me only fires when greenApiEnabled is off
      // AND autoOpenWhatsApp is on.
      const trimmedPhone = customerPhone.trim();
      if (trimmedPhone && result.saleIds.length > 0) {
        // Receipts are sent as PDF attachments in v1 — no public web URL.
        // The {{receiptLink}} substitution is kept for template compatibility
        // but always resolves to "" so the line drops out of the message.
        const receiptLink = "";
        const message = substitute(settings.messageTemplate, {
          customerName: customerName.trim() || "عميلنا الكريم",
          customerPhone: trimmedPhone,
          invoiceId: result.invoiceId,
          invoiceCode: result.invoiceId.slice(-8).toUpperCase(),
          totalPrice: formatPrice(total),
          productNames: lines.map((l) => l.product.name).join("، "),
          receiptLink,
          date: saleDate.toLocaleDateString("ar-EG"),
          shopName: settings.shopName,
          shopPhone: settings.shopPhone,
        });

        if (settings.greenApiEnabled) {
          // Hard kill-switch: never open a tab when this toggle is on.
          if (!settings.greenApiInstanceId || !settings.greenApiToken) {
            console.warn(
              "[whatsapp] Green API enabled but credentials missing — skipping send (no tab opened)"
            );
          } else if (settings.sendAsPdf) {
            // PDF mode: build a clean caption WITHOUT the receipt link
            // (the customer is getting the PDF itself, no link needed).
            const captionRaw = substitute(settings.messageTemplate, {
              customerName: customerName.trim() || "عميلنا الكريم",
              customerPhone: trimmedPhone,
              invoiceId: result.invoiceId,
              invoiceCode: result.invoiceId.slice(-8).toUpperCase(),
              totalPrice: formatPrice(total),
              productNames: lines.map((l) => l.product.name).join("، "),
              receiptLink: "",
              date: saleDate.toLocaleDateString("ar-EG"),
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
        <h3 className="font-semibold">تسجيل بيع جديد</h3>
        {cart.length > 0 && (
          <span className="text-xs px-2 py-1 rounded-full bg-accent-light text-accent font-medium">
            {cart.length} منتج في الفاتورة
          </span>
        )}
      </div>

      <div className="space-y-4">
        <ProductSearchSelect value={selectedProduct} onChange={setSelectedProduct} />

        {!selectedProduct && cart.length === 0 && recentProducts.length > 0 && (
          <div>
            <p className="text-xs text-text-secondary mb-2">منتجات حديثة:</p>
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
              المتاح: {remainingStockForCurrent} قطعة
            </p>

            <Input
              label="الكمية"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              min={1}
              max={remainingStockForCurrent}
              error={
                quantity > remainingStockForCurrent
                  ? `الحد الأقصى: ${remainingStockForCurrent}`
                  : undefined
              }
            />

            <Input
              label="سعر الوحدة (جنيه)"
              type="number"
              value={pricePerUnit}
              onChange={(e) => setPricePerUnit(Number(e.target.value))}
              min={1}
            />

            <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <p className="text-xs font-medium text-text-secondary">خصم على هذا المنتج (اختياري)</p>
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
                  نسبة
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
                  مبلغ
                </button>
              </div>
              <Input
                label={lineDiscountType === "percentage" ? "نسبة %" : "مبلغ ج.م"}
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
              إضافة للفاتورة
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
                    <p className="font-medium truncate">{line.product.name}</p>
                    <p className="text-xs text-text-secondary">
                      {line.quantity} × {formatPrice(line.pricePerUnit)}
                      {ld > 0 && (
                        <span className="text-danger ms-1">
                          (خصم - {formatPrice(ld)})
                        </span>
                      )}
                    </p>
                  </div>
                  <span className="font-bold whitespace-nowrap">
                    {formatPrice(lineSubtotal - ld)}
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
                خصم على إجمالي الفاتورة (اختياري)
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
                  نسبة
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
                  مبلغ
                </button>
              </div>
              <Input
                label={orderDiscountType === "percentage" ? "نسبة %" : "مبلغ ج.م"}
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
                <span className="text-text-secondary">المجموع الفرعي</span>
                <span>{formatPrice(cartSubtotalGross)}</span>
              </div>
              {cartLineDiscountTotal > 0 && (
                <div className="flex justify-between text-danger">
                  <span>خصومات بنود</span>
                  <span>- {formatPrice(cartLineDiscountTotal)}</span>
                </div>
              )}
              {orderDiscountAmount > 0 && (
                <div className="flex justify-between text-danger">
                  <span>خصم الفاتورة</span>
                  <span>- {formatPrice(orderDiscountAmount)}</span>
                </div>
              )}
              <div className="border-t border-accent/20 pt-1 flex justify-between font-bold">
                <span>الإجمالي</span>
                <span className="text-2xl text-accent">{formatPrice(cartTotal)}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <CustomerAutocomplete
                field="name"
                label="اسم العميل (اختياري)"
                placeholder="ابدأ الكتابة لاختيار عميل سابق..."
                value={customerName}
                onChange={setCustomerName}
                onPick={handleCustomerPick}
                suggestions={pastCustomers}
              />
              <CustomerAutocomplete
                field="phone"
                label="رقم الموبايل"
                placeholder="ابدأ الكتابة لاختيار رقم سابق..."
                value={customerPhone}
                onChange={setCustomerPhone}
                onPick={handleCustomerPick}
                suggestions={pastCustomers}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                طريقة الدفع
              </label>
              <div className="grid grid-cols-4 gap-1 rounded-lg overflow-hidden border border-border">
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
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
                    {PAYMENT_METHOD_LABELS[m]}
                  </button>
                ))}
              </div>
              {paymentMethod === "deferred" && (
                <p className="mt-1 text-xs text-orange-600">
                  ستُسجَّل الفاتورة كآجل غير مدفوع.
                </p>
              )}
            </div>

            <Input
              label="ملاحظة (اختياري)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="ملاحظة..."
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
                  تسجيل الفاتورة بتاريخ سابق
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
              تسجيل الفاتورة
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
            طباعة الفاتورة
          </Button>
        </div>
      )}
    </div>
  );
}
