import type { ApiClient } from "../http";
import type { MeResponse } from "../types";

/**
 * Identity, tenant, active branch, switchable branches and EFFECTIVE
 * permissions in one call — the app's session bootstrap.
 */
export async function getMe(client: ApiClient): Promise<MeResponse> {
  return client.request<MeResponse>("/api/v1/me");
}
