import { ApiError } from "@matgary/api-client";

import { t } from "@/i18n";

/**
 * Error copy for anything a screen shows the user.
 *
 * `ApiError.message` is whatever the transport could find: the server's prose
 * (`detail`, or an Arabic sentence the older handlers put straight in
 * `error`), else the machine code, else `HTTP <status>`. Screens that printed
 * `error.message` verbatim therefore showed a shopkeeper
 * "PASSWORD_CHANGE_REQUIRED" or "HTTP 500". Everything renders through here
 * instead: a code is mapped to the sentence the app already uses for it, a
 * kind falls back to the shared copy, and only text that reads as prose is
 * ever shown as-is.
 */

/** The four walls the interceptor routes on (doc 02 §1.1 rows 19/25/26). */
const WALL_TEXT: Record<string, () => string> = {
  TENANT_SUSPENDED: () => t("mobile.common.tenantSuspended"),
  PASSWORD_CHANGE_REQUIRED: () => t("mobile.common.passwordChangeRequired"),
  SUBSCRIPTION_REQUIRED: () => t("mobile.common.subscriptionInactive"),
  PERMISSION_DENIED: () => t("mobile.errors.permissionDenied"),
};

/**
 * Why the device was signed out, worded for the login screen. The refresh
 * route answers three ways (apps/web/app/api/v1/auth/refresh/route.ts):
 *
 *   SESSION_REVOKED       — "sign out everywhere" (users.token_version bump)
 *   TOKEN_REUSE_DETECTED  — a rotated refresh token was presented again
 *   INVALID_REFRESH_TOKEN — expired, logged out, reinstalled, OR revoked
 *                           from the devices screen: the server deliberately
 *                           answers a device revoke with the plain code, so it
 *                           is not distinguishable here and gets the generic
 *                           sentence.
 *
 * Also the two 403s that kill a session outright (NO_TENANT, USER_NOT_FOUND)
 * and any 401 the client could not refresh past — generic as well.
 */
export function sessionEndedText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "SESSION_REVOKED":
      return t("mobile.auth.sessionRevoked");
    case "TOKEN_REUSE_DETECTED":
      return t("mobile.auth.sessionReuse");
    default:
      return t("mobile.auth.sessionEnded");
  }
}

/**
 * True when `text` is something a person wrote for a person — not a machine
 * code (`INSUFFICIENT_STOCK`), a transport placeholder (`HTTP 403`,
 * `Non-JSON response (502)`), or the client's own "Session ended".
 */
export function isHumanText(text: string | null | undefined): text is string {
  if (!text) return false;
  const s = text.trim();
  if (!s) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) return false;
  if (/^HTTP \d+$/.test(s)) return false;
  if (/^Non-JSON response/.test(s)) return false;
  if (s === "Session ended") return false;
  return true;
}

/**
 * The one line to show for `error`. `fallback` is the screen's own sentence
 * for "this action failed" and is what unclassified errors get.
 */
export function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;

  if (error.code && WALL_TEXT[error.code]) return WALL_TEXT[error.code]!();
  if (error.fatalToSession) return sessionEndedText(error);

  switch (error.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "rateLimited":
      return t("mobile.common.tooManyAttempts");
    case "server":
      return t("mobile.common.serverError");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "billing":
      return t("mobile.common.subscriptionInactive");
    default:
      break;
  }

  // A 4xx with prose from the server — the older handlers' Arabic sentences,
  // a validation detail — is worth more than a generic line. Codes and
  // placeholders are not.
  if (error.status !== null && error.status < 500 && isHumanText(error.message)) {
    return error.message;
  }
  return fallback;
}
