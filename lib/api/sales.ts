// Client-side wrappers around the sales API.
// Same function names the legacy firestore.ts exposed so callers swap
// import path only.

import type { Sale, DiscountType, PaymentMethod } from "@/lib/types";

export interface SaleExtras {
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
}

export interface CartSaleLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number;
}

export interface CartSaleResult {
  invoiceId: string;
  saleIds: string[];
}

interface SaleApiRow extends Omit<Sale, "saleDate" | "returnedAt" | "paidAt"> {
  saleDate: string;
  returnedAt?: string;
  paidAt?: string;
}

function reviveSale(s: SaleApiRow): Sale {
  return {
    ...s,
    saleDate: new Date(s.saleDate),
    returnedAt: s.returnedAt ? new Date(s.returnedAt) : undefined,
    paidAt: s.paidAt ? new Date(s.paidAt) : undefined,
  };
}

async function jsonFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

export async function listSales(): Promise<Sale[]> {
  const json = await jsonFetch<{ data: SaleApiRow[] }>("/api/sales");
  return json.data.map(reviveSale);
}

export async function getSaleById(saleId: string): Promise<Sale | null> {
  try {
    const json = await jsonFetch<{ data: SaleApiRow }>(`/api/sales/${saleId}`);
    return reviveSale(json.data);
  } catch {
    return null;
  }
}

export async function recordSale(
  productId: string,
  quantitySold: number,
  pricePerUnit: number,
  note?: string,
  discountType?: DiscountType,
  discountValue?: number,
  customDate?: Date,
  invoiceId?: string,
  extras?: SaleExtras,
): Promise<string> {
  const res = await jsonFetch<{ saleId: string }>("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      productId,
      quantitySold,
      pricePerUnit,
      note,
      discountType,
      discountValue,
      customDate: customDate?.toISOString(),
      invoiceId,
      ...extras,
    }),
  });
  return res.saleId;
}

export async function recordCartSale(
  lines: CartSaleLineInput[],
  options: {
    note?: string;
    orderDiscountType?: DiscountType;
    orderDiscountValue?: number;
    customDate?: Date;
    customerName?: string;
    customerPhone?: string;
    paymentMethod?: PaymentMethod;
  } = {},
): Promise<CartSaleResult> {
  return jsonFetch<CartSaleResult>("/api/sales/cart", {
    method: "POST",
    body: JSON.stringify({
      lines,
      options: { ...options, customDate: options.customDate?.toISOString() },
    }),
  });
}

export async function updateSale(
  saleId: string,
  updates: {
    quantitySold?: number;
    pricePerUnit?: number;
    discountType?: DiscountType | null;
    discountValue?: number | null;
    note?: string;
    saleDate?: Date;
  },
): Promise<void> {
  await jsonFetch(`/api/sales/${saleId}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...updates,
      saleDate: updates.saleDate?.toISOString(),
    }),
  });
}

export async function voidSale(saleId: string): Promise<void> {
  await jsonFetch(`/api/sales/${saleId}`, { method: "DELETE" });
}

export async function markSalePaid(saleId: string): Promise<void> {
  await jsonFetch(`/api/sales/${saleId}/paid`, { method: "POST" });
}

export async function markInvoicePaid(invoiceId: string): Promise<void> {
  await jsonFetch(`/api/sales/invoice/${encodeURIComponent(invoiceId)}/paid`, {
    method: "POST",
  });
}

export async function bulkDeleteSales(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await jsonFetch("/api/sales/bulk", {
    method: "DELETE",
    body: JSON.stringify({ ids }),
  });
}
