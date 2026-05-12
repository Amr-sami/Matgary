// GET /api/whatsapp/oauth/start
//
// Entry point for Embedded Signup. The browser hits this with the user's
// session cookie, we mint a signed state token bound to (tenantId,
// branchId, userId), drop it as an httpOnly cookie, and 302 to the Meta
// OAuth dialog. The callback route below verifies both the HMAC and the
// cookie match before exchanging the code.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import {
  buildOAuthAuthorizeUrl,
  readMetaConfig,
  assertMetaConfigured,
  MetaGraphError,
} from "@/lib/whatsapp/meta-graph";
import {
  signState,
  oauthStateCookieAttributes,
} from "@/lib/whatsapp/oauth-state";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const cfg = readMetaConfig();
  try {
    assertMetaConfigured(cfg);
  } catch (err) {
    logger.warn({
      event: "wa.oauth.start.not_configured",
      tenantId: auth.ctx.tenantId,
      branchId: auth.ctx.branchId,
      message: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof MetaGraphError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.status },
      );
    }
    throw err;
  }

  const signed = signState({
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    userId: auth.ctx.userId,
  });
  const cookieStore = await cookies();
  cookieStore.set(signed.cookieName, signed.state, oauthStateCookieAttributes());

  logger.info({
    event: "wa.oauth.start",
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    userId: auth.ctx.userId,
    flowId: signed.flowId,
  });

  const url = buildOAuthAuthorizeUrl(cfg, signed.state);
  return NextResponse.redirect(url);
}
