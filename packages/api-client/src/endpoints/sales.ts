import type { ApiClient } from "../http";

/**
 * The POS write. Body shape read from apps/web/app/api/sales/cart/route.ts.
 *
 * `quantity` here, NOT `quantitySold` — the older POST /api/sales uses the other
 * name for the same field and mixing them is a 400 that typechecking cannot
 * catch.
 */
export interface CartLineInput {
  productId: string;
  quantity: number;
  pricePerUnit: number;
  lineDiscountType?: "percentage" | "fixed";
  lineDiscountValue?: number;
}

export type PaymentMethod = "cash" | "instapay" | "card" | "deferred";

export interface CartOptions {
  note?: string;
  orderDiscountType?: "percentage" | "fixed";
  orderDiscountValue?: number;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  /** Client-minted, so a receipt printed offline matches the server record. */
  invoiceId?: string;
  amountPaidNow?: number;
  /**
   * ISO datetime of the moment the sale was rung. The route books
   * `customDate ?? now`, so a sale rung offline at 22:00 and drained at 09:00
   * lands on the day the customer's receipt shows, not the day it synced.
   */
  customDate?: string;
}

/** apps/web/lib/repo/operations.ts — CartSaleResult */
export interface CartSaleResult {
  invoiceId: string;
  saleIds: string[];
  lines: { productId: string; productName: string; quantity: number; lineTotal: number }[];
  total: number;
  paymentMethod: PaymentMethod;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
}

/**
 * The exact JSON the cart route receives. Both the live POS write and the
 * offline outbox go through `sendCartSale`, so the two paths send
 * byte-identical bodies — the outbox stores this object with JSON.stringify
 * and parses it back before sending; key order survives that round trip.
 */
export interface CartSaleBody {
  lines: CartLineInput[];
  options: CartOptions;
}

export function buildCartSaleBody(lines: CartLineInput[], options: CartOptions): CartSaleBody {
  return { lines, options };
}

/**
 * POST a prepared body. `extraHeaders` is for the outbox's `X-Outbox-Branch`
 * (apps/web/app/api/sales/cart/route.ts refuses, with a 409, a row rung at a
 * branch the cashier has since switched away from — better than booking it
 * at the wrong branch). Never pass Idempotency-Key here; it is a parameter so
 * it cannot be forgotten.
 */
export async function sendCartSale(
  client: ApiClient,
  body: CartSaleBody,
  idempotencyKey: string,
  extraHeaders: Record<string, string> = {},
): Promise<CartSaleResult> {
  return client.request<CartSaleResult>("/api/sales/cart", {
    method: "POST",
    body,
    headers: { ...extraHeaders, "Idempotency-Key": idempotencyKey },
  });
}

/**
 * Record a sale.
 *
 * `idempotencyKey` is the one thing that makes this safe to retry. The route
 * caches the response for 24h per (tenant, key), so a replay after a dropped
 * connection returns the ORIGINAL result instead of booking the sale twice.
 * This is the only write route with that guarantee — a retried POST
 * /api/expenses creates a duplicate row — which is why the offline outbox
 * (phase 3) is built around this endpoint specifically.
 *
 * 8..64 chars of [A-Za-z0-9_-]; a UUID v4 qualifies.
 */
export async function recordCartSale(
  client: ApiClient,
  lines: CartLineInput[],
  options: CartOptions,
  idempotencyKey: string,
): Promise<CartSaleResult> {
  return sendCartSale(client, buildCartSaleBody(lines, options), idempotencyKey);
}

// ---------------------------------------------------------------------------
// Sales history — the read side. Shapes read from apps/web/lib/types.ts (Sale)
// and apps/web/app/api/sales/route.ts (GET, `?paginated=1`).
//
// One `sales` row is ONE LINE of an invoice; a cart sale with three products
// is three rows sharing an `invoiceId`. Screens that want "an invoice" group
// rows with `groupInvoices` below.

/** apps/web/lib/types.ts — Sale, dates as ISO strings over the wire. */
export interface SaleRecord {
  id: string;
  invoiceId?: string;
  productId: string;
  productName: string;
  category: string;
  gender: string;
  brand?: string;
  quantitySold: number;
  pricePerUnit: number;
  costPriceAtSale?: number;
  /** quantity × pricePerUnit, before any discount. */
  subtotal: number;
  discountType?: "percentage" | "fixed";
  discountValue?: number;
  /** Line discount + this line's share of the order discount. */
  discountAmount?: number;
  totalPrice: number;
  saleDate: string;
  isReturned: boolean;
  returnedAt?: string;
  returnedQuantity?: number;
  note?: string;
  customerName?: string;
  customerPhone?: string;
  paymentMethod?: PaymentMethod;
  isPaid?: boolean;
  paidAt?: string;
  amountPaid?: number;
  partialPaidAt?: string;
}

export interface SalesPage {
  data: SaleRecord[];
  /** Pass back as `cursor`; null on the last page. */
  nextCursor: string | null;
  branchId: string | null;
}

export interface ListSalesPageParams {
  cursor?: string | null;
  /** 1..200, server default 50. */
  limit?: number;
  /**
   * Override the X-Branch-Id scope for this read: a branch id the caller may
   * access, or `"all"` (owner only — anyone else gets 403 FORBIDDEN_BRANCH).
   */
  branchId?: string | "all";
}

/**
 * GET /api/sales?paginated=1 — newest first, `(saleDate, id)` cursor. The
 * route has no date / payment / search filters in this mode; the history
 * screen filters client-side and stops paging once a page's oldest row is
 * older than the selected range.
 */
export async function listSalesPage(
  client: ApiClient,
  params: ListSalesPageParams = {},
): Promise<SalesPage> {
  const qs = new URLSearchParams({ paginated: "1" });
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.branchId) qs.set("branchId", params.branchId);
  return client.request<SalesPage>(`/api/sales?${qs.toString()}`);
}

/** GET /api/sales/[id] — one line. 404 → ApiError. */
export async function getSale(client: ApiClient, id: string): Promise<SaleRecord> {
  const res = await client.request<{ data: SaleRecord }>(`/api/sales/${encodeURIComponent(id)}`);
  return res.data;
}

/**
 * Every line of one invoice, for a screen that only knows a line id (deep
 * link, push notification) and has no cached history page.
 *
 * There is no `/api/sales?invoiceId=` on the web. The cursor format is the
 * documented `<saleDate ISO>:<saleId>` and the page filter is a strict
 * `(saleDate, id) < cursor`, so anchoring one millisecond after the line's
 * own timestamp with an all-`f` id returns that instant's rows first — every
 * line of a cart sale shares its `saleDate`. A line whose date was later
 * edited on the web falls outside the anchor and is dropped; the line the
 * caller fetched is always included.
 */
export async function listInvoiceLines(
  client: ApiClient,
  line: SaleRecord,
  opts: ListInvoiceLinesOptions = {},
): Promise<SaleRecord[]> {
  return (await listInvoiceLinesDetailed(client, line, opts)).lines;
}

export interface ListInvoiceLinesOptions {
  /**
   * `GET /api/sales/[id]` is tenant-wide but the paginated list is scoped to
   * the X-Branch-Id header, so a line from another branch finds no siblings.
   * When the caller is an owner, set this to retry with `branchId=all`.
   */
  allBranches?: boolean;
}

export interface InvoiceLinesResult {
  lines: SaleRecord[];
  /**
   * False when the anchored page did not even contain the line the caller
   * already holds — it lives in another branch (non-owner) or its `saleDate`
   * was edited — so its siblings are most likely missing too. Screens should
   * warn instead of presenting `lines` as the whole invoice.
   */
  complete: boolean;
}

/** `listInvoiceLines` plus a flag saying whether the reconstruction can be trusted. */
export async function listInvoiceLinesDetailed(
  client: ApiClient,
  line: SaleRecord,
  opts: ListInvoiceLinesOptions = {},
): Promise<InvoiceLinesResult> {
  if (!line.invoiceId) return { lines: [line], complete: true };
  const anchor = new Date(new Date(line.saleDate).getTime() + 1);
  if (Number.isNaN(anchor.getTime())) return { lines: [line], complete: false };
  const cursor = `${anchor.toISOString()}:ffffffff-ffff-ffff-ffff-ffffffffffff`;

  const fetchSiblings = async (branchId?: "all") => {
    const page = await listSalesPage(client, { cursor, limit: 100, branchId });
    return page.data.filter((r) => r.invoiceId === line.invoiceId);
  };

  let lines = await fetchSiblings();
  let complete = lines.some((r) => r.id === line.id);
  if (!complete && opts.allBranches) {
    // The header branch did not hold the sale; an owner may read them all.
    lines = await fetchSiblings("all");
    complete = lines.some((r) => r.id === line.id);
  }
  if (complete) return { lines, complete: true };
  return { lines: [line, ...lines.filter((r) => r.id !== line.id)], complete: false };
}

/** One invoice as the history list and the detail screen see it. */
export interface Invoice {
  /** `invoiceId`, or the line id for legacy rows written without one. */
  key: string;
  invoiceId: string | null;
  /** Newest line's date — the lines of a cart sale share it anyway. */
  saleDate: string;
  lines: SaleRecord[];
  /** Σ subtotal (gross, before discounts). */
  subtotal: number;
  /** Σ discountAmount. */
  discount: number;
  /** Σ totalPrice of every line, returned or not — what the receipt said. */
  total: number;
  /** Σ totalPrice of lines NOT returned — what the shop actually kept. */
  netTotal: number;
  /** Σ amountPaid. */
  amountPaid: number;
  paymentMethod: PaymentMethod | null;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
  /** True when at least one line was (partly) returned. */
  hasReturn: boolean;
  /** True when every line was returned. */
  fullyReturned: boolean;
  /** Deferred and not settled. */
  outstanding: number;
}

/**
 * Group line rows into invoices, preserving the rows' order (newest first
 * from the API). Rows without an `invoiceId` become single-line invoices.
 */
export function groupInvoices(rows: SaleRecord[]): Invoice[] {
  const byKey = new Map<string, Invoice>();
  const order: Invoice[] = [];
  for (const r of rows) {
    const key = r.invoiceId ?? r.id;
    let inv = byKey.get(key);
    if (!inv) {
      inv = {
        key,
        invoiceId: r.invoiceId ?? null,
        saleDate: r.saleDate,
        lines: [],
        subtotal: 0,
        discount: 0,
        total: 0,
        netTotal: 0,
        amountPaid: 0,
        paymentMethod: r.paymentMethod ?? null,
        customerName: r.customerName ?? null,
        customerPhone: r.customerPhone ?? null,
        note: r.note ?? null,
        hasReturn: false,
        fullyReturned: true,
        outstanding: 0,
      };
      byKey.set(key, inv);
      order.push(inv);
    }
    inv.lines.push(r);
    inv.subtotal += r.subtotal ?? 0;
    inv.discount += r.discountAmount ?? 0;
    inv.total += r.totalPrice ?? 0;
    inv.amountPaid += r.amountPaid ?? 0;
    if (r.isReturned || (r.returnedQuantity ?? 0) > 0) inv.hasReturn = true;
    if (!r.isReturned) {
      inv.fullyReturned = false;
      inv.netTotal += r.totalPrice ?? 0;
    }
    if (!inv.customerName && r.customerName) inv.customerName = r.customerName;
    if (!inv.customerPhone && r.customerPhone) inv.customerPhone = r.customerPhone;
    if (!inv.note && r.note) inv.note = r.note;
    if (!inv.paymentMethod && r.paymentMethod) inv.paymentMethod = r.paymentMethod;
  }
  for (const inv of order) {
    if (inv.lines.length === 0) inv.fullyReturned = false;
    inv.subtotal = round2(inv.subtotal);
    inv.discount = round2(inv.discount);
    inv.total = round2(inv.total);
    inv.netTotal = round2(inv.netTotal);
    inv.amountPaid = round2(inv.amountPaid);
    inv.outstanding =
      inv.paymentMethod === "deferred" ? Math.max(0, round2(inv.netTotal - inv.amountPaid)) : 0;
  }
  return order;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
