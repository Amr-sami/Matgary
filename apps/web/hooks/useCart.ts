"use client";

// Cart state machine. Lifted from SaleForm.tsx so the cart + line
// builder logic lives in a focused, testable surface and SaleForm
// can shrink toward an orchestrator.
//
// Responsibilities:
//   - Currently-composed line: selectedProduct, quantity, price, line discount
//   - Accumulated cart lines
//   - Stock-reservation math (qty reserved by cart for a product)
//   - Mutations: add to cart, scan-merge (via applyScanToCart), remove line
//   - URL hand-off: ?preselect=<id> picks a product on mount
//   - Auto-sync: when selectedProduct changes, pricePerUnit follows
//
// Pure helpers used:
//   lib/sales/scan-cart.ts: applyScanToCart (the in-cart merge rule)
//
// NOT in this hook:
//   - Submit pipeline (useCheckout, future)
//   - Order-level adjustments (useOrderAdjustments)
//   - Customer / payment / loyalty (useCustomerPayment)

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { applyScanToCart } from "@/lib/sales/scan-cart";
import type { CartLine } from "@/lib/sales/scan-cart";
import type { DiscountType, Product } from "@/lib/types";

export type CartLineState = CartLine;

export interface UseCartOptions {
  /** All-products list — needed for the ?preselect= deep-link AND
   *  for stock-availability math. SaleForm already holds this via
   *  useProducts; passed as input so the hook stays free of fetch. */
  products: Product[];
  /** Pre-select a product on mount (used when the page passes
   *  preselectedProduct prop, separate from the ?preselect URL flow). */
  preselectedProduct?: Product | null;
}

export interface UseCartResult {
  // Current line being composed
  selectedProduct: Product | null;
  setSelectedProduct: (p: Product | null) => void;
  quantity: number;
  setQuantity: (n: number) => void;
  pricePerUnit: number;
  setPricePerUnit: (n: number) => void;
  lineDiscountType: DiscountType;
  setLineDiscountType: (t: DiscountType) => void;
  lineDiscountValue: number;
  setLineDiscountValue: (n: number) => void;

  // Accumulated cart
  cart: CartLineState[];
  setCart: React.Dispatch<React.SetStateAction<CartLineState[]>>;

  // Derived
  /** Quantity of `productId` already in the cart (across all lines). */
  stockReservedFor: (productId: string) => number;
  /** Stock left for the currently-selected product after subtracting
   *  what's already in the cart. */
  remainingStockForCurrent: number;
  /** Gate for the "Add to cart" button — covers stock, qty, and price. */
  canAddCurrentLine: boolean;

  // Mutations
  /** Add the current in-progress line to the cart, then reset the
   *  line builder. Caller must guard with canAddCurrentLine. */
  handleAddToCart: () => void;
  /** Barcode-scan flow: merge into existing line or append qty=1.
   *  See applyScanToCart for the merge rule. */
  handleScanProduct: (product: Product) => void;
  handleRemoveLine: (idx: number) => void;

  /** Build a preview list that includes the in-progress line. Used
   *  by the totals preview so the cashier sees the line they're
   *  composing reflected in the totals. */
  buildPreviewLines: () => CartLineState[];
}

export function useCart({ products, preselectedProduct }: UseCartOptions): UseCartResult {
  const searchParams = useSearchParams();

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(
    preselectedProduct || null,
  );
  const [quantity, setQuantity] = useState(1);
  const [pricePerUnit, setPricePerUnit] = useState(0);
  const [lineDiscountType, setLineDiscountType] = useState<DiscountType>("percentage");
  const [lineDiscountValue, setLineDiscountValue] = useState(0);
  const [cart, setCart] = useState<CartLineState[]>([]);

  // When the selected product changes, default the unit price to the
  // catalog price. The cashier can still edit it.
  useEffect(() => {
    if (selectedProduct) {
      setPricePerUnit(selectedProduct.price);
    }
  }, [selectedProduct]);

  // ?preselect=<id> deep-link from /inventory quick-sell. Apply once
  // when products are available, then strip the param so a refresh
  // doesn't re-trigger.
  useEffect(() => {
    const id = searchParams.get("preselect");
    if (!id) return;
    const p = products.find((x) => x.id === id);
    if (p) setSelectedProduct(p);
    const url = new URL(window.location.href);
    url.searchParams.delete("preselect");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

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

  const handleScanProduct = (product: Product) => {
    setCart((prev) => applyScanToCart(prev, product));
    setSelectedProduct(null);
    setQuantity(1);
    setPricePerUnit(0);
    setLineDiscountValue(0);
  };

  const handleRemoveLine = (idx: number) => {
    setCart((prev) => prev.filter((_, i) => i !== idx));
  };

  const buildPreviewLines = (): CartLineState[] => {
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
  };

  return {
    selectedProduct,
    setSelectedProduct,
    quantity,
    setQuantity,
    pricePerUnit,
    setPricePerUnit,
    lineDiscountType,
    setLineDiscountType,
    lineDiscountValue,
    setLineDiscountValue,
    cart,
    setCart,
    stockReservedFor,
    remainingStockForCurrent,
    canAddCurrentLine,
    handleAddToCart,
    handleScanProduct,
    handleRemoveLine,
    buildPreviewLines,
  };
}
