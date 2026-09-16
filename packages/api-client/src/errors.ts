/**
 * The error taxonomy every caller branches on.
 *
 * The API answers with `{ error: "CODE" }` and an HTTP status. Callers must not
 * read either directly: a screen that does `if (status === 401) signOut()` is
 * wrong, because 401 covers both "your token expired, we already refreshed it"
 * and "your session was revoked, you really are signed out". The `kind` below
 * is what UI should switch on.
 */

export type ApiErrorKind =
  /** Network never reached the server. Retryable, and the offline queue's cue. */
  | "offline"
  /** Reached the server, no answer in time. Retryable. */
  | "timeout"
  /** Credentials rejected at sign-in. Not retryable. */
  | "credentials"
  /** Session is gone for good — revoked, reused, or refresh failed. Sign out. */
  | "session"
  /** Authenticated, but not allowed. Do not retry, do not sign out. */
  | "forbidden"
  /** Tenant suspended / subscription lapsed. A billing wall, not an auth error. */
  | "billing"
  /** 404. */
  | "notFound"
  /** 409 — includes TOTP_REQUIRED, which needs a challenge screen. */
  | "conflict"
  /** 422 / 400 — the request was malformed or failed validation. */
  | "validation"
  /** 429. Carries retryAfter when the server sent one. */
  | "rateLimited"
  /** 5xx. Retryable. */
  | "server"
  /** Anything unclassified — a proxy error page, a JSON parse failure. */
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** The server's machine code, e.g. "TOKEN_REUSE_DETECTED". Null when offline. */
  readonly code: string | null;
  readonly status: number | null;
  readonly retryAfterSec: number | null;

  constructor(opts: {
    kind: ApiErrorKind;
    code?: string | null;
    status?: number | null;
    message?: string;
    retryAfterSec?: number | null;
  }) {
    super(opts.message ?? opts.code ?? opts.kind);
    this.name = "ApiError";
    this.kind = opts.kind;
    this.code = opts.code ?? null;
    this.status = opts.status ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
  }

  /** True when a blind retry is reasonable. Drives the outbox backoff later. */
  get retryable(): boolean {
    return (
      this.kind === "offline" ||
      this.kind === "timeout" ||
      this.kind === "server" ||
      this.kind === "rateLimited"
    );
  }

  /** True when the only correct response is to drop the session. */
  get fatalToSession(): boolean {
    return this.kind === "session";
  }
}

/** Server codes that mean the session is unrecoverable — no retry will help. */
const DEAD_SESSION_CODES = new Set([
  "INVALID_REFRESH_TOKEN",
  "TOKEN_REUSE_DETECTED",
  "SESSION_REVOKED",
  "NO_TENANT",
  "USER_NOT_FOUND",
]);

export function classify(status: number, code: string | null): ApiErrorKind {
  if (code && DEAD_SESSION_CODES.has(code)) return "session";

  switch (status) {
    case 400:
      return "validation";
    case 401:
      return code === "INVALID_CREDENTIALS" ? "credentials" : "session";
    case 402:
      // SUBSCRIPTION_REQUIRED. A wall, not a failure.
      return "billing";
    case 403:
      // TENANT_SUSPENDED and PASSWORD_CHANGE_REQUIRED also land on 403 but are
      // billing/account walls rather than permission denials.
      return code === "TENANT_SUSPENDED" || code === "PASSWORD_CHANGE_REQUIRED"
        ? "billing"
        : "forbidden";
    case 404:
      return "notFound";
    case 409:
      return "conflict";
    case 422:
      return "validation";
    case 429:
      return "rateLimited";
    default:
      if (status >= 500) return "server";
      return "unknown";
  }
}
