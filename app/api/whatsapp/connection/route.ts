// GET /api/whatsapp/connection
//
// Settings UI reads this to render the connection card (status badge,
// connected phone number, sandbox/live mode, scopes granted). The token
// is *never* returned — only metadata.

import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getActiveConnection } from "@/lib/whatsapp/connections";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const conn = await getActiveConnection(auth.ctx.tenantId, auth.ctx.branchId);
  return NextResponse.json({
    connected: !!conn,
    connection: conn
      ? {
          id: conn.id,
          provider: conn.provider,
          wabaId: conn.wabaId,
          phoneNumberId: conn.phoneNumberId,
          businessId: conn.businessId,
          displayPhoneNumber: conn.displayPhoneNumber,
          verifiedName: conn.verifiedName,
          status: conn.status,
          mode: conn.mode,
          webhookSubscribed: conn.webhookSubscribed,
          scopes: conn.scopes,
          tokenType: conn.tokenType,
          tokenExpiresAt: conn.tokenExpiresAt,
          connectedAt: conn.connectedAt,
          lastSyncedAt: conn.lastSyncedAt,
          lastError: conn.lastError,
        }
      : null,
  });
}
