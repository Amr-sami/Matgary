import { create } from "zustand";
import { computeCartTotals, type DiscountType } from "@matgary/domain";
import type { Product } from "@matgary/api-client";

import { mintInvoiceId } from "@/offline/invoice-id";

/**
 * The POS cart.
 *
 * Totals come from `computeCartTotals` in @matgary/domain — the SAME function
 * the web's SaleForm uses and the server's recordCartSale mirrors, so the
 * number the cashier sees is the number that gets booked. It moved out of the
 * web app for exactly this: two clients, one arithmetic.
 *
 * Each cart carries an invoice id from the moment it is opened. That is what
 * lets a receipt be shown (and, later, printed) before the server has
 * confirmed anything, and what makes a retry safe: the id is also the
 * Idempotency-Key, so a replay after a dropped connection returns the original
 * sale instead of booking it twice. The id is device-scoped (doc 06 §6.5,
 * offline/invoice-id.ts) so two tills of one shop cannot mint the same one.
 *
 * `available` is captured from the product list at add time; offline that
 * list already carries localDelta (offline/local-delta-cache.ts) — the units
 * rung by still-queued sales are subtracted — so a second offline sale is
 * capped at what is really left on the shelf.
 */

export interface CartLine {
  productId: string;
  name: string;
  pricePerUnit: number;
  quantity: number;
  /** Stock on hand when added — the client-side cap before the server checks. */
  available: number;
  lineDiscountType: DiscountType;
  lineDiscountValue: number;
}

interface CartState {
  invoiceId: string;
  lines: CartLine[];
  orderDiscountType: DiscountType;
  orderDiscountValue: number;
  customerName: string;
  customerPhone: string;
  note: string;

  add: (product: Product) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  setCustomer: (name: string, phone: string) => void;
  setOrderDiscount: (type: DiscountType, value: number) => void;
  setNote: (note: string) => void;
  /** New empty cart with a fresh invoice id. Called after a successful sale. */
  reset: () => void;
}

const empty = () => ({
  invoiceId: mintInvoiceId(),
  lines: [] as CartLine[],
  orderDiscountType: "fixed" as DiscountType,
  orderDiscountValue: 0,
  customerName: "",
  customerPhone: "",
  note: "",
});

export const useCart = create<CartState>((set) => ({
  ...empty(),

  add: (product) =>
    set((s) => {
      const existing = s.lines.find((l) => l.productId === product.id);
      if (existing) {
        // Cap at stock. The server refuses over-sell with INSUFFICIENT_STOCK;
        // capping here just saves the round trip and the error toast.
        const quantity = Math.min(existing.quantity + 1, existing.available);
        return {
          lines: s.lines.map((l) =>
            l.productId === product.id ? { ...l, quantity } : l,
          ),
        };
      }
      if (product.quantity <= 0) return s;
      return {
        lines: [
          ...s.lines,
          {
            productId: product.id,
            name: product.name,
            pricePerUnit: product.price,
            quantity: 1,
            available: product.quantity,
            lineDiscountType: "fixed",
            lineDiscountValue: 0,
          },
        ],
      };
    }),

  setQuantity: (productId, quantity) =>
    set((s) => ({
      lines: s.lines
        .map((l) =>
          l.productId === productId
            ? { ...l, quantity: Math.max(0, Math.min(quantity, l.available)) }
            : l,
        )
        // Quantity 0 is "remove", the way a cashier expects the minus button to
        // behave on the last unit.
        .filter((l) => l.quantity > 0),
    })),

  remove: (productId) =>
    set((s) => ({ lines: s.lines.filter((l) => l.productId !== productId) })),

  setCustomer: (customerName, customerPhone) => set({ customerName, customerPhone }),
  setOrderDiscount: (orderDiscountType, orderDiscountValue) =>
    set({ orderDiscountType, orderDiscountValue }),
  setNote: (note) => set({ note }),
  reset: () => set(empty()),
}));

/** Derived totals. A selector so screens re-render only when lines change. */
export function selectTotals(s: CartState) {
  return computeCartTotals(s.lines, {
    type: s.orderDiscountType,
    value: s.orderDiscountValue,
  });
}

export function selectItemCount(s: CartState) {
  return s.lines.reduce((n, l) => n + l.quantity, 0);
}
