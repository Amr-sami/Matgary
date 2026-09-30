/**
 * Error copy for the collections settings screens (doc 15 spec 09 §4.8).
 *
 * A server code with a sentence in 05's `app.collections.errors.*` wins, and
 * is checked FIRST: `errorText` (src/lib/errors.ts) maps every 403 to the
 * generic `mobile.common.forbidden`, which would hide COLLECTIONS_DISABLED /
 * FORBIDDEN_BRANCH / INGEST_DISABLED. Anything else falls through to
 * `errorText(e, fallback)` (offline, timeout, 5xx, rate limit…).
 */
import { ApiError } from "@matgary/api-client";

import { t } from "@/i18n";
import { errorText } from "@/lib/errors";

import type { AccountColumn, AccountFormError } from "./account-form";

/** 03 §B.15 codes the settings / setup screens can meet, all with 05 copy. */
export const SETUP_ERROR_CODES = [
  // 09 §4.8
  "COLLECTIONS_DISABLED",
  "COLLECTION_ACCOUNT_NOT_FOUND",
  "INVALID_IPA_LINK",
  "INVALID_WALLET_NUMBER",
  "INVALID_IBAN",
  "DEVICE_LIMIT_REACHED",
  "INGEST_DISABLED",
  "INGEST_TOKEN_INVALID",
  "INGEST_DEVICE_REVOKED",
  "INGEST_PAYLOAD_TOO_LARGE",
  // The account routes' other codes (05 §4.14, 03 §B.15 as landed).
  "ACCOUNT_IDENTITY_REQUIRED",
  "PROVIDER_RAIL_MISMATCH",
  "COLLECTION_ACCOUNT_DUPLICATE",
  "FORBIDDEN_BRANCH",
  "INVALID_BRANCH",
  "DEVICE_NOT_FOUND",
  "IDEMPOTENCY_MISMATCH",
  "INVALID_REQUEST",
] as const;

export function errorCode(e: unknown): string | null {
  return e instanceof ApiError ? e.code : null;
}

/** The one line to show for a failed collections-settings request. */
export function collectionsErrorText(e: unknown, fallback: string): string {
  const code = errorCode(e);
  if (code && (SETUP_ERROR_CODES as readonly string[]).includes(code)) {
    return t(`app.collections.errors.${code}`);
  }
  return errorText(e, fallback);
}

/**
 * A failed account save. The duplicate-number 409 (and any other 409 the
 * form cannot otherwise explain) is the form's own sentence
 * `form.duplicate` (09 §4.4 "Errors"), not 05's generic one.
 */
export function accountSaveErrorText(e: unknown): string {
  if (e instanceof ApiError && (e.code === "COLLECTION_ACCOUNT_DUPLICATE" || (e.status === 409 && e.code !== "IDEMPOTENCY_MISMATCH"))) {
    return t("app.collectionsSettings.form.duplicate");
  }
  return collectionsErrorText(e, t("app.collectionsSettings.form.saveFailed"));
}

/** A server 400 that names one field: highlight it like the local rule would. */
export function serverFieldError(e: unknown): { column: AccountColumn; error: AccountFormError } | null {
  switch (errorCode(e)) {
    case "INVALID_IPA_LINK":
      return { column: "ipa_link", error: "fields.ipaLink.invalid" };
    case "INVALID_WALLET_NUMBER":
      return { column: "wallet_msisdn", error: "fields.walletMsisdn.invalid" };
    case "INVALID_IBAN":
      return { column: "iban", error: "fields.iban.checksum" };
    case "ACCOUNT_IDENTITY_REQUIRED":
      return { column: "identity", error: "identityRequired" };
    default:
      return null;
  }
}
