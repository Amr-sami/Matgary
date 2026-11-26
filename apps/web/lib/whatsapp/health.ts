// Connection health check.
//
// Runs a sequence of Graph calls against the tenant's stored token and
// classifies the outcome into a small set of `connection_error_state`
// values the UI can map to actionable banners ("Reconnect", "Verify
// number", "Try again", etc.). Writes the result back to wa_connections
// so the UI doesn't have to re-run the check on every render.

import "server-only";
import {
  debugToken,
  listPhoneNumbersForWaba,
  getBusinessForWaba,
  readMetaConfig,
  MetaGraphError,
  META_OAUTH_SCOPES,
} from "./meta-graph";
import {
  getActiveConnectionToken,
  recordHealthcheck,
  type ConnectionErrorState,
  type WaConnectionPublic,
} from "./connections";
import { logger } from "@/lib/logger";

export interface HealthCheckDiagnostic {
  ok: boolean;
  errorState: ConnectionErrorState;
  // Short human note suitable for the settings UI banner.
  note: string;
  // Things the UI can render under "Details" — never includes the token.
  details: Record<string, unknown>;
  // True when reconnecting via Embedded Signup is the right next action.
  needsReauth: boolean;
}

export interface HealthCheckResult extends HealthCheckDiagnostic {
  // Echo of relevant connection metadata so the caller doesn't have to
  // re-fetch separately. Token-bearing fields are omitted.
  connection: WaConnectionPublic | null;
}

const NO_CONNECTION: HealthCheckResult = {
  ok: false,
  errorState: "unknown",
  note: "No active WhatsApp connection for this branch.",
  details: {},
  needsReauth: true,
  connection: null,
};

/** Classify a Meta Graph error into a ConnectionErrorState. Heuristics
 *  follow Meta's documented OAuthException codes:
 *    100/190 / subcode 458 → token revoked
 *    190 / subcode 463      → token expired
 *    102 / 4               → permission / token problem
 *    1/2 / 4xx other       → network or transient
 */
function classifyError(err: MetaGraphError): ConnectionErrorState {
  const code = err.code ?? 0;
  // The Graph error payload may carry a `subcode` we surfaced into `raw`.
  const sub = (err.raw && typeof err.raw === "object" && "error" in err.raw)
    ? ((err.raw as { error?: { error_subcode?: number; subcode?: number } })
        .error?.error_subcode ??
      (err.raw as { error?: { error_subcode?: number; subcode?: number } })
        .error?.subcode ??
      null)
    : null;

  if (code === 190 && (sub === 458 || sub === 459 || sub === 460)) {
    return "token_revoked";
  }
  if (code === 190 && (sub === 463 || sub === 467)) return "token_expired";
  if (code === 190 || code === 102 || code === 4 || code === 10) {
    return "token_revoked";
  }
  if (err.status === 401 || err.status === 403) return "token_revoked";
  if (err.status === 404) return "waba_inaccessible";
  if (err.status >= 500) return "network";
  return "unknown";
}

export async function runHealthCheck(
  tenantId: string,
  branchId: string,
): Promise<HealthCheckResult> {
  const active = await getActiveConnectionToken(tenantId, branchId);
  if (!active) return NO_CONNECTION;

  const cfg = readMetaConfig();
  const ctx = {
    tenantId,
    branchId,
    connectionId: active.conn.id,
    wabaId: active.conn.wabaId,
    phoneNumberId: active.conn.phoneNumberId,
  };

  const details: Record<string, unknown> = {};
  let errorState: ConnectionErrorState = "ok";
  let note = "Connection is healthy.";
  let needsReauth = false;
  let statusOverride: "expired" | "revoked" | "error" | undefined;

  // 1. /debug_token — does Meta still consider this token valid?
  try {
    const dbg = await debugToken(cfg, active.token);
    details.tokenValid = dbg.data?.is_valid ?? false;
    details.scopes = dbg.data?.scopes ?? [];
    if (dbg.data?.expires_at && dbg.data.expires_at > 0) {
      details.expiresAt = new Date(dbg.data.expires_at * 1000).toISOString();
    }
    if (!dbg.data?.is_valid) {
      errorState = "token_revoked";
      note = "Meta reports this access token is no longer valid. Reconnect to refresh.";
      needsReauth = true;
      statusOverride = "revoked";
    } else {
      const missingScopes = META_OAUTH_SCOPES.filter(
        (s) => !(dbg.data?.scopes ?? []).includes(s),
      );
      if (missingScopes.length > 0) {
        errorState = "scope_missing";
        note = `Token is missing required scopes: ${missingScopes.join(", ")}. Reconnect and approve all permissions.`;
        details.missingScopes = missingScopes;
        needsReauth = true;
      }
    }
  } catch (err) {
    if (err instanceof MetaGraphError) {
      errorState = classifyError(err);
      note =
        errorState === "token_expired" || errorState === "token_revoked"
          ? "Token expired or revoked. Reconnect to issue a new one."
          : `Graph rejected the token (status ${err.status}).`;
      needsReauth =
        errorState === "token_expired" || errorState === "token_revoked";
      statusOverride =
        errorState === "token_expired"
          ? "expired"
          : errorState === "token_revoked"
            ? "revoked"
            : undefined;
      details.metaCode = err.code;
      details.status = err.status;
    } else {
      errorState = "network";
      note = "Could not reach Meta Graph. Try again in a moment.";
      details.networkError = err instanceof Error ? err.message : String(err);
    }
  }

  // 2. If the token is good, probe the WABA + phone number for runtime
  //    health (verification, quality rating, messaging limit tier).
  if (errorState === "ok") {
    try {
      const phones = await listPhoneNumbersForWaba(cfg, active.conn.wabaId, active.token);
      const me = phones.data?.find((p) => p.id === active.conn.phoneNumberId);
      if (!me) {
        errorState = "phone_unverified";
        note =
          "The connected phone number is no longer linked to this WABA. Reconnect and re-select the number.";
        needsReauth = true;
      } else {
        details.phone = {
          displayPhoneNumber: me.display_phone_number,
          verifiedName: me.verified_name,
          qualityRating: me.quality_rating,
          codeVerificationStatus: me.code_verification_status,
          messagingLimitTier: me.messaging_limit_tier,
        };
        if (
          me.code_verification_status &&
          me.code_verification_status !== "VERIFIED"
        ) {
          errorState = "phone_unverified";
          note = `Phone number status is "${me.code_verification_status}". Verify it in Meta Business Manager before sending.`;
        }
      }
    } catch (err) {
      if (err instanceof MetaGraphError) {
        errorState = classifyError(err);
        note = `WABA check failed (status ${err.status}).`;
        details.metaCode = err.code;
      } else {
        errorState = "network";
        note = "Could not reach Meta Graph (WABA check).";
      }
    }
  }

  // 3. Optional business verification — purely informational; doesn't
  //    flip ok→error, but feeds the sandbox/live badge.
  try {
    const biz = await getBusinessForWaba(cfg, active.conn.wabaId, active.token);
    if (biz) {
      details.business = {
        id: biz.id,
        name: biz.name,
        verificationStatus: biz.verification_status,
      };
    }
  } catch {
    // ignore — non-fatal for the health check
  }

  // Persist outcome.
  await recordHealthcheck(tenantId, active.conn.id, {
    errorState,
    note: errorState === "ok" ? null : note,
    rawMetadata: { ...((active.conn.connectedAt && {}) || {}), healthcheck: details },
    statusOverride,
  });

  logger.info({
    event: "wa.healthcheck.completed",
    ...ctx,
    errorState,
    needsReauth,
  });

  return {
    ok: errorState === "ok",
    errorState,
    note,
    details,
    needsReauth,
    // Re-fetch is unnecessary — the in-memory copy is good enough for the
    // API response. We don't include the token here (only metadata).
    connection: { ...active.conn, connectionErrorState: errorState },
  };
}
