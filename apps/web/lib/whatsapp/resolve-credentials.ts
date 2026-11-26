// Resolve which credentials to send WhatsApp Cloud API messages with.
//
// Precedence (highest first):
//   1. An *active* wa_connections row for (tenant, branch) — set by the
//      Embedded Signup OAuth flow. Token is decrypted here.
//   2. Manual columns on shop_settings (whatsapp_cloud_*) — the temporary
//      fallback for tenants who haven't gone through OAuth yet.
//
// Returns null if neither source has usable creds; callers respond 409.
// Never logs the token.

import "server-only";
import { getActiveConnectionToken } from "./connections";
import { getWhatsAppCloudCredentials } from "@/lib/repo/settings";

export type CredentialSource = "oauth" | "manual";

export interface ResolvedCredentials {
  source: CredentialSource;
  phoneNumberId: string;
  token: string;
  // Whether the active connection had sandbox vs live mode. Manual creds
  // default to 'sandbox' because we can't know without a Graph call.
  mode: "sandbox" | "live";
}

export async function resolveCloudCredentials(
  tenantId: string,
  branchId: string,
): Promise<ResolvedCredentials | null> {
  // 1. Embedded Signup connection wins.
  const oauth = await getActiveConnectionToken(tenantId, branchId);
  if (oauth && oauth.token && oauth.conn.phoneNumberId) {
    return {
      source: "oauth",
      phoneNumberId: oauth.conn.phoneNumberId,
      token: oauth.token,
      mode: oauth.conn.mode,
    };
  }

  // 2. Manual fallback.
  const manual = await getWhatsAppCloudCredentials(tenantId, branchId);
  if (manual.enabled && manual.phoneId && manual.token) {
    return {
      source: "manual",
      phoneNumberId: manual.phoneId,
      token: manual.token,
      mode: "sandbox",
    };
  }

  return null;
}
