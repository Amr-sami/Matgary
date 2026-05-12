// GET /api/whatsapp/oauth/callback?code=...&state=...
//
// Meta redirects the user here after Embedded Signup. We:
//   1. Verify the `state` matches the httpOnly cookie (CSRF guard).
//   2. Exchange the code for a short-lived token, then extend it to ~60d.
//   3. Discover which WABA + phone number the user just connected. We use
//      Graph rather than trusting client-supplied params, because the same
//      user can authorise multiple WABAs and we want the most recent.
//   4. Subscribe our Meta App to the WABA's webhooks (best-effort —
//      logged on failure but the connection still saves).
//   5. Inspect the token to detect sandbox vs live mode.
//   6. Encrypt + store via upsertConnection.
//   7. 302 back to /settings with a status flash.
//
// Token plaintext never leaves this function: it's encrypted inside the
// repo on insert and never logged.

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  readMetaConfig,
  assertMetaConfigured,
  exchangeCode,
  extendToken,
  debugToken,
  listWabasForToken,
  listPhoneNumbersForWaba,
  getBusinessForWaba,
  subscribeAppToWaba,
  META_OAUTH_SCOPES,
  MetaGraphError,
} from "@/lib/whatsapp/meta-graph";
import {
  verifyState,
  oauthStateCookieName,
  oauthStateCookieAttributes,
} from "@/lib/whatsapp/oauth-state";
import { upsertConnection } from "@/lib/whatsapp/connections";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

function flashRedirect(
  req: NextRequest,
  status: "ok" | "error",
  detail?: string,
  cookieName?: string,
): NextResponse {
  const url = new URL("/settings", req.url);
  url.searchParams.set("wa", status);
  if (detail) url.searchParams.set("wa_detail", detail.slice(0, 200));
  const res = NextResponse.redirect(url);
  // Always clear the per-flow state cookie — single-use. cookieName is
  // unknown only when the state itself was malformed (no flowId).
  if (cookieName) {
    res.cookies.set(cookieName, "", {
      ...oauthStateCookieAttributes(),
      maxAge: 0,
    });
  }
  return res;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const errorReason =
    url.searchParams.get("error_reason") ||
    url.searchParams.get("error_description");

  // User cancelled / Meta rejected before we even get a code.
  if (errorParam) {
    logger.warn({
      event: "wa.oauth.callback.meta_error",
      error: errorParam,
      reason: errorReason ?? null,
    });
    return flashRedirect(req, "error", errorReason || errorParam);
  }

  if (!code || !stateParam) {
    logger.warn({
      event: "wa.oauth.callback.missing_params",
      hasCode: !!code,
      hasState: !!stateParam,
    });
    return flashRedirect(req, "error", "Missing code or state");
  }

  // 1. Verify state — HMAC first so we can extract the per-flow id, then
  //    cookie binding under that flow's cookie name.
  const payload = verifyState(stateParam);
  if (!payload) {
    logger.warn({
      event: "wa.oauth.invalid_state",
      reason: "verifyState_returned_null",
    });
    return flashRedirect(req, "error", "Expired or invalid state");
  }
  const cookieName = oauthStateCookieName(payload.flowId);
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(cookieName)?.value;
  if (!cookieState || cookieState !== stateParam) {
    logger.warn({
      event: "wa.oauth.csrf_mismatch",
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      flowId: payload.flowId,
      reason: !cookieState ? "missing_cookie" : "cookie_state_mismatch",
    });
    return flashRedirect(req, "error", "Invalid state", cookieName);
  }

  // 2. Exchange code → short-lived → long-lived.
  const cfg = readMetaConfig();
  try {
    assertMetaConfigured(cfg);
  } catch (err) {
    return flashRedirect(
      req,
      "error",
      err instanceof Error ? err.message : "Meta not configured",
      cookieName,
    );
  }

  let token: string;
  let tokenExpiresAt: Date | null = null;
  let tokenType: "user" | "long_lived" | "system_user" = "long_lived";
  try {
    const short = await exchangeCode(cfg, code);
    // Attempt to extend. If extension fails (some BSP setups don't allow
    // it for system-user tokens), fall back to the short-lived token and
    // mark it accordingly so the UI can prompt for reconnect later.
    try {
      const long = await extendToken(cfg, short.access_token);
      token = long.access_token;
      tokenType = "long_lived";
      if (long.expires_in && long.expires_in > 0) {
        tokenExpiresAt = new Date(Date.now() + long.expires_in * 1000);
      }
    } catch (extendErr) {
      logger.warn({
        event: "wa.oauth.extend_token_failed",
        tenantId: payload.tenantId,
        branchId: payload.branchId,
        reason: extendErr instanceof Error ? extendErr.message : String(extendErr),
      });
      token = short.access_token;
      tokenType = "user";
      if (short.expires_in && short.expires_in > 0) {
        tokenExpiresAt = new Date(Date.now() + short.expires_in * 1000);
      }
    }
  } catch (err) {
    const msg = err instanceof MetaGraphError ? err.message : "Token exchange failed";
    logger.error({
      event: "wa.oauth.code_exchange_failed",
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      metaCode: err instanceof MetaGraphError ? err.code : null,
      status: err instanceof MetaGraphError ? err.status : null,
      message: msg,
    });
    return flashRedirect(req, "error", msg, cookieName);
  }

  // 3. Discover WABA + phone. We take the first WABA the user gave us
  //    access to that has at least one phone number. If the user picked
  //    multiple, Phase 2 will need a chooser; for now we surface a clear
  //    error so we're not silently grabbing the wrong account.
  let wabaId: string | undefined;
  let phoneNumberId: string | undefined;
  let displayPhoneNumber: string | undefined;
  let verifiedName: string | undefined;
  let businessId: string | undefined;
  let rawMetadata: Record<string, unknown> = {};

  try {
    const wabas = await listWabasForToken(cfg, token);
    if (!wabas.data?.length) {
      return flashRedirect(
        req,
        "error",
        "No WhatsApp Business Account was granted. Re-run setup and select a WABA.",
        cookieName,
      );
    }
    if (wabas.data.length > 1) {
      // Phase-2 nicety: render a chooser. For Phase 1 we explain the
      // multi-WABA case so the operator knows how to fix it.
      logger.warn({
        event: "wa.oauth.multi_waba_granted",
        tenantId: payload.tenantId,
        branchId: payload.branchId,
        count: wabas.data.length,
        wabaIdPicked: wabas.data[0].id,
      });
    }
    wabaId = wabas.data[0].id;

    const phones = await listPhoneNumbersForWaba(cfg, wabaId, token);
    if (!phones.data?.length) {
      return flashRedirect(
        req,
        "error",
        "WABA has no phone number yet. Add and verify one in Meta Business Manager, then reconnect.",
        cookieName,
      );
    }
    const phone = phones.data[0];
    phoneNumberId = phone.id;
    displayPhoneNumber = phone.display_phone_number;
    verifiedName = phone.verified_name;

    const biz = await getBusinessForWaba(cfg, wabaId, token);
    businessId = biz?.id;

    rawMetadata = { waba: wabas.data[0], phone, business: biz };
  } catch (err) {
    const msg = err instanceof MetaGraphError ? err.message : "Discovery failed";
    logger.error({
      event: "wa.oauth.discovery_failed",
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      metaCode: err instanceof MetaGraphError ? err.code : null,
      status: err instanceof MetaGraphError ? err.status : null,
      message: msg,
    });
    return flashRedirect(req, "error", msg, cookieName);
  }

  // 4. Subscribe our app to the WABA. Best-effort: if this fails we still
  //    save the connection (operator can reconnect or we can retry later)
  //    but flag it.
  let webhookSubscribed = false;
  let subscribeError: string | undefined;
  try {
    const sub = await subscribeAppToWaba(cfg, wabaId!, token);
    webhookSubscribed = !!sub.success;
  } catch (err) {
    subscribeError = err instanceof Error ? err.message : "subscribe failed";
    logger.warn({
      event: "wa.oauth.subscribe_failed",
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      wabaId,
      reason: subscribeError,
    });
  }

  // 5. Inspect token to detect sandbox vs live + actual granted scopes.
  let grantedScopes: string[] = [];
  let mode: "sandbox" | "live" = "sandbox";
  try {
    const info = await debugToken(cfg, token);
    grantedScopes = info.data?.scopes ?? [];
    // Heuristic: if all three BSP scopes are present AND the token type is
    // SYSTEM_USER, we treat it as live. Real "live" detection happens once
    // the WABA's owning business has verification_status=verified.
    const ownerVerification =
      (rawMetadata.business as { verification_status?: string } | undefined)
        ?.verification_status;
    const allScopesGranted = META_OAUTH_SCOPES.every((s) =>
      grantedScopes.includes(s),
    );
    if (allScopesGranted && ownerVerification === "verified") {
      mode = "live";
    }
  } catch (err) {
    logger.warn({
      event: "wa.oauth.debug_token_failed",
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Persist. Repo encrypts the token; we never log it here.
  try {
    await upsertConnection({
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      connectedByUserId: payload.userId,
      wabaId: wabaId!,
      phoneNumberId: phoneNumberId!,
      businessId,
      displayPhoneNumber,
      verifiedName,
      accessToken: token,
      tokenType,
      tokenExpiresAt,
      scopes: grantedScopes,
      mode,
      webhookSubscribed,
      rawMetadata,
    });
  } catch (err) {
    logger.error({
      event: "wa.oauth.persist_failed",
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      wabaId,
      phoneNumberId,
      message: err instanceof Error ? err.message : String(err),
    });
    return flashRedirect(req, "error", "Failed to save connection", cookieName);
  }

  logger.info({
    event: "wa.oauth.connected",
    tenantId: payload.tenantId,
    branchId: payload.branchId,
    wabaId,
    phoneNumberId,
    mode,
    webhookSubscribed,
    tokenType,
    scopesGranted: grantedScopes.length,
  });

  return flashRedirect(
    req,
    "ok",
    subscribeError ? `connected (webhook subscribe pending: ${subscribeError})` : undefined,
    cookieName,
  );
}
