import type { ApiClient } from "../http";
import type { DashboardResponse } from "../types";

/**
 * Today's headline numbers plus the low-stock bucket, in one call.
 *
 * Omitting `branchId` uses the active branch from the X-Branch-Id header.
 * Passing "all" aggregates across the tenant and is owner-only — the server
 * rejects it for everyone else rather than silently narrowing.
 */
export async function getDashboard(
  client: ApiClient,
  branchId?: string | "all",
): Promise<DashboardResponse> {
  return client.request<DashboardResponse>("/api/v1/dashboard", {
    query: branchId ? { branchId } : undefined,
  });
}
