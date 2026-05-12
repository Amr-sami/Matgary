// Meta Graph API client for the WhatsApp Cloud API.
//
// Scoped narrowly to what Phase 1 (Embedded Signup onboarding) needs:
//   - exchangeCode: short-lived user token from the OAuth code
//   - extendToken:  short-lived → long-lived (60d) token
//   - debugToken:   inspect scopes + expiry on a token (used to detect
//                   whether App Review approved us for the BSP scopes)
//   - listWabasForToken / listPhoneNumbersForWaba: discover what the user
//                   actually granted access to so we don't trust the JS
//                   SDK's `extras.waba_id` blindly
//   - subscribeAppToWaba: register OUR app's webhook for the tenant's WABA
//   - getBusinessVerification: detect sandbox vs live mode
//
// All requests are versioned (`META_GRAPH_VERSION`, default v21.0). Errors
// are normalised to a single shape so callers don't have to special-case
// Graph's variant responses. Token strings are *never* logged.

import "server-only";
import { logger } from "@/lib/logger";

const DEFAULT_VERSION = "v21.0";
const GRAPH_BASE = "https://graph.facebook.com";

// Public OAuth dialog lives at facebook.com, not graph. Easy to mix up.
const OAUTH_DIALOG_BASE = "https://www.facebook.com";

export interface MetaConfig {
  appId: string;
  appSecret: string;
  configId?: string;
  redirectUri: string;
  graphVersion: string;
}

export class MetaGraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | null,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

// Centralised env reader. Throws *only* when the caller actually needs a
// missing var — keeps the import-time surface light so unrelated routes
// don't crash on cold start in environments where Meta isn't configured.
export function readMetaConfig(): MetaConfig {
  const appId = process.env.META_APP_ID || "";
  const appSecret = process.env.META_APP_SECRET || "";
  const configId = process.env.META_CONFIG_ID || undefined;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URL || "";
  const graphVersion = process.env.META_GRAPH_VERSION || DEFAULT_VERSION;
  return { appId, appSecret, configId, redirectUri, graphVersion };
}

export function assertMetaConfigured(cfg: MetaConfig): void {
  const missing: string[] = [];
  if (!cfg.appId) missing.push("META_APP_ID");
  if (!cfg.appSecret) missing.push("META_APP_SECRET");
  if (!cfg.redirectUri) missing.push("META_OAUTH_REDIRECT_URL");
  if (missing.length > 0) {
    throw new MetaGraphError(
      `Meta App is not configured: missing ${missing.join(", ")}`,
      500,
      null,
      null,
    );
  }
}

// Build the OAuth dialog URL the browser is redirected to. Scopes are
// hardcoded — App Review approval is for the exact triple below, so the
// app shouldn't ever request a different combination.
export const META_OAUTH_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
  "business_management",
] as const;

export function buildOAuthAuthorizeUrl(
  cfg: MetaConfig,
  state: string,
): string {
  assertMetaConfigured(cfg);
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    state,
    response_type: "code",
    scope: META_OAUTH_SCOPES.join(","),
  });
  if (cfg.configId) {
    // Login for Business "config_id" — pre-bakes the Embedded Signup UI
    // (WABA selection, phone-number creation/verify, permissions) into a
    // single popup. Without it, the user lands on a generic FB permissions
    // page that doesn't surface the WhatsApp setup steps.
    params.set("config_id", cfg.configId);
    params.set("override_default_response_type", "true");
  }
  return `${OAUTH_DIALOG_BASE}/${cfg.graphVersion}/dialog/oauth?${params.toString()}`;
}

// ─── Internal HTTP helper ────────────────────────────────────────────────

interface GraphRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown> | FormData;
  // Token is passed as Authorization: Bearer when present. Some endpoints
  // (e.g. /oauth/access_token) want app_id|app_secret in the query string
  // instead — those callers leave token undefined and pass query params
  // themselves.
  token?: string;
  query?: Record<string, string | undefined>;
}

async function graphRequest<T>(
  cfg: MetaConfig,
  path: string,
  { method = "GET", body, token, query }: GraphRequestOptions = {},
): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${cfg.graphVersion}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let bodyInit: BodyInit | undefined;
  if (body instanceof FormData) {
    bodyInit = body;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }

  const startedAt = Date.now();
  const res = await fetch(url.toString(), { method, headers, body: bodyInit });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON; fall through to error path with raw text.
  }

  if (!res.ok) {
    const errBody = json as
      | { error?: { message?: string; code?: number; subcode?: number; type?: string } }
      | null;
    const msg =
      errBody?.error?.message ||
      `Meta Graph ${method} ${path} returned ${res.status}`;
    // Never log Authorization header / tokens — path + Meta error codes only.
    logger.warn({
      event: "wa.graph.error",
      method,
      path,
      status: res.status,
      durationMs: Date.now() - startedAt,
      metaCode: errBody?.error?.code ?? null,
      metaSubcode: errBody?.error?.subcode ?? null,
      metaType: errBody?.error?.type ?? null,
      message: msg,
    });
    throw new MetaGraphError(
      msg,
      res.status,
      errBody?.error?.code ?? null,
      json ?? text,
    );
  }

  logger.debug({
    event: "wa.graph.ok",
    method,
    path,
    status: res.status,
    durationMs: Date.now() - startedAt,
  });

  return (json as T) ?? ({} as T);
}

// ─── Token lifecycle ─────────────────────────────────────────────────────

export interface AccessTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/** Step 1 of OAuth: exchange the `code` from the callback for a short-lived
 *  user access token (typically ~1 hour TTL). */
export async function exchangeCode(
  cfg: MetaConfig,
  code: string,
): Promise<AccessTokenResponse> {
  return graphRequest<AccessTokenResponse>(cfg, "/oauth/access_token", {
    method: "GET",
    query: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: cfg.redirectUri,
      code,
    },
  });
}

/** Step 2: extend the short-lived user token to a long-lived (~60 day)
 *  token. The response shape is identical to exchangeCode. */
export async function extendToken(
  cfg: MetaConfig,
  shortLivedToken: string,
): Promise<AccessTokenResponse> {
  return graphRequest<AccessTokenResponse>(cfg, "/oauth/access_token", {
    method: "GET",
    query: {
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });
}

export interface DebugTokenResponse {
  data: {
    app_id?: string;
    type?: string;
    application?: string;
    expires_at?: number; // unix seconds; 0 = never expires
    data_access_expires_at?: number;
    is_valid?: boolean;
    scopes?: string[];
    granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
    user_id?: string;
  };
}

/** Inspect a token: useful for telling whether the App Review review
 *  granted the BSP scopes (so we can show "sandbox" vs "live" in the UI). */
export async function debugToken(
  cfg: MetaConfig,
  inputToken: string,
): Promise<DebugTokenResponse> {
  // Meta wants the *app* token (or app_id|app_secret) as the caller for
  // /debug_token, not the token being inspected.
  const appAccessToken = `${cfg.appId}|${cfg.appSecret}`;
  return graphRequest<DebugTokenResponse>(cfg, "/debug_token", {
    method: "GET",
    query: { input_token: inputToken, access_token: appAccessToken },
  });
}

// ─── Discovery: WABA + phone numbers + business ─────────────────────────

export interface WabaListResponse {
  data: Array<{
    id: string;
    name?: string;
    currency?: string;
    timezone_id?: string;
    message_template_namespace?: string;
  }>;
}

/** List every WABA the access token can see. Empty data array means the
 *  user didn't actually grant whatsapp_business_management. */
export async function listWabasForToken(
  cfg: MetaConfig,
  userToken: string,
): Promise<WabaListResponse> {
  // The user's businesses → each business has client_whatsapp_business_accounts
  // and owned_whatsapp_business_accounts. We flatten both into one list.
  type BusinessesResp = {
    data: Array<{
      id: string;
      client_whatsapp_business_accounts?: WabaListResponse;
      owned_whatsapp_business_accounts?: WabaListResponse;
    }>;
  };
  const businesses = await graphRequest<BusinessesResp>(cfg, "/me/businesses", {
    token: userToken,
    query: {
      fields:
        "id,client_whatsapp_business_accounts{id,name,currency,timezone_id,message_template_namespace},owned_whatsapp_business_accounts{id,name,currency,timezone_id,message_template_namespace}",
    },
  });
  const seen = new Set<string>();
  const out: WabaListResponse["data"] = [];
  for (const biz of businesses.data ?? []) {
    for (const w of biz.client_whatsapp_business_accounts?.data ?? []) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        out.push(w);
      }
    }
    for (const w of biz.owned_whatsapp_business_accounts?.data ?? []) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        out.push(w);
      }
    }
  }
  return { data: out };
}

export interface PhoneNumberListResponse {
  data: Array<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    code_verification_status?: string;
    messaging_limit_tier?: string;
  }>;
}

export async function listPhoneNumbersForWaba(
  cfg: MetaConfig,
  wabaId: string,
  token: string,
): Promise<PhoneNumberListResponse> {
  return graphRequest<PhoneNumberListResponse>(cfg, `/${encodeURIComponent(wabaId)}/phone_numbers`, {
    token,
    query: {
      fields:
        "id,display_phone_number,verified_name,quality_rating,code_verification_status,messaging_limit_tier",
    },
  });
}

export interface BusinessInfo {
  id: string;
  name?: string;
  verification_status?: string;
}

export async function getBusinessForWaba(
  cfg: MetaConfig,
  wabaId: string,
  token: string,
): Promise<BusinessInfo | null> {
  type Resp = {
    id: string;
    owner_business_info?: BusinessInfo;
    on_behalf_of_business_info?: BusinessInfo;
  };
  const resp = await graphRequest<Resp>(cfg, `/${encodeURIComponent(wabaId)}`, {
    token,
    query: {
      fields:
        "id,owner_business_info{id,name,verification_status},on_behalf_of_business_info{id,name,verification_status}",
    },
  });
  return resp.owner_business_info ?? resp.on_behalf_of_business_info ?? null;
}

// ─── Webhook subscription ────────────────────────────────────────────────

/** Register our Meta App as the subscriber for this WABA's webhook events
 *  (messages, statuses). Called once per connection right after we store
 *  the token. Idempotent on Meta's side. */
export async function subscribeAppToWaba(
  cfg: MetaConfig,
  wabaId: string,
  token: string,
): Promise<{ success?: boolean }> {
  return graphRequest<{ success?: boolean }>(
    cfg,
    `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    { method: "POST", token },
  );
}

export async function unsubscribeAppFromWaba(
  cfg: MetaConfig,
  wabaId: string,
  token: string,
): Promise<{ success?: boolean }> {
  return graphRequest<{ success?: boolean }>(
    cfg,
    `/${encodeURIComponent(wabaId)}/subscribed_apps`,
    { method: "DELETE", token },
  );
}
