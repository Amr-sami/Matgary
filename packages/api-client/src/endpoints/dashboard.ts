import type { ApiClient } from "../http";
import type { DashboardResponse } from "../types";
import type { PaymentMethod } from "./sales";

/**
 * One invoice in the home-screen "recent sales" strip. Server-side a cart
 * sale is N `sales` rows sharing an invoiceId; the route folds them so the
 * phone shows one card per sale event, the way a shopkeeper counts them.
 */
export interface RecentSale {
  /** A sale row id inside the invoice (the newest line) — what /sales/[id] opens. */
  id: string;
  /** Shared invoice ref ("INV-…"); null for a legacy single-line sale. */
  invoiceId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Sum of the invoice's line totals after line discounts. */
  total: number;
  paymentMethod: PaymentMethod | null;
  /** ISO saleDate. */
  createdAt: string;
  /** Units sold across the invoice (sum of the lines' quantitySold). */
  itemCount: number;
  /** True when every line has been returned. */
  isReturned: boolean;
  isPaid: boolean;
}

/**
 * GET /api/v1/dashboard as it ships today: the headline stats, the low-stock
 * bucket and the last `recentSales` invoices (newest first, at most 8, `[]`
 * when the branch has none).
 */
export interface DashboardHomeResponse extends DashboardResponse {
  recentSales: RecentSale[];
}

/**
 * Today's headline numbers, the low-stock bucket and the recent-sales strip,
 * in one call.
 *
 * Omitting `branchId` uses the active branch from the X-Branch-Id header.
 * Passing "all" aggregates across the tenant and is owner-only — the server
 * rejects it for everyone else rather than silently narrowing.
 */
export async function getDashboard(
  client: ApiClient,
  branchId?: string | "all",
): Promise<DashboardHomeResponse> {
  return client.request<DashboardHomeResponse>("/api/v1/dashboard", {
    query: branchId ? { branchId } : undefined,
  });
}
