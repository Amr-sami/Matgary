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
  /** Credentials rejected at sign-in — password, 2FA code, or a spent 2FA
   *  challenge. Not retryable. */
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
  /**
   * The parsed JSON body of the failed response, when there was one. Most
   * callers never need it — `kind` and `code` are the contract — but a few
   * errors carry data the next step needs: the 409 TOTP_REQUIRED that holds
   * a `challengeToken`, the 401 INVALID_CODE that holds `attemptsLeft`. Read
   * it through a typed helper (endpoints/auth.ts), not inline.
   */
  readonly body: unknown;

  constructor(opts: {
    kind: ApiErrorKind;
    code?: string | null;
    status?: number | null;
    message?: string;
    retryAfterSec?: number | null;
    body?: unknown;
  }) {
    super(opts.message ?? opts.code ?? opts.kind);
    this.name = "ApiError";
    this.kind = opts.kind;
    this.code = opts.code ?? null;
    this.status = opts.status ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.body = opts.body ?? null;
  }

  /**
   * One of the three routed walls — TENANT_SUSPENDED, SUBSCRIPTION_REQUIRED,
   * PASSWORD_CHANGE_REQUIRED. Not PERMISSION_DENIED: that is a verdict on the
   * request itself and re-sending it changes nothing.
   */
  get wall(): boolean {
    const blocked = blockedCodeOf(this.status, this.code);
    return blocked !== null && blocked !== "PERMISSION_DENIED";
  }

  /**
   * True when a blind retry is reasonable. Drives the outbox backoff later.
   *
   * A wall counts as retryable (doc 06 §5.3): a sale queued offline must
   * survive the subscription lapsing or an admin forcing a password change —
   * the request was valid, the account is temporarily gated, and the moment
   * the gate lifts the same request is correct to send. Dropping it would
   * lose the sale. The outbox must still stop draining while `wall` is true
   * (the router has sent the user to fix it) rather than hammer the server.
   */
  get retryable(): boolean {
    return (
      this.kind === "offline" ||
      this.kind === "timeout" ||
      this.kind === "server" ||
      this.kind === "rateLimited" ||
      this.wall
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
      // The three sign-in rejections: a wrong password, a wrong second
      // factor, and a 2FA challenge that is no longer redeemable. None of
      // them is about an existing session — there is none yet.
      return code === "INVALID_CREDENTIALS" || code === "INVALID_CODE" || code === "CHALLENGE_EXPIRED"
        ? "credentials"
        : "session";
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

/**
 * The four responses that mean "stop what you are doing and go somewhere
 * else" — a wall the app must route to, not an error a screen should render
 * inline. Codes are the server's own machine strings (middleware.ts and
 * lib/api/auth-helpers.ts), except PERMISSION_DENIED, which normalises the
 * `{ error: "Forbidden" }` body that every `requirePermission*` helper sends.
 *
 *   TENANT_SUSPENDED         403 → /service-paused
 *   SUBSCRIPTION_REQUIRED    402 → /billing
 *   PASSWORD_CHANGE_REQUIRED 403 → /settings/change-password
 *   PERMISSION_DENIED        403 → non-blocking banner, stay on screen
 */
export type BlockedCode =
  | "TENANT_SUSPENDED"
  | "SUBSCRIPTION_REQUIRED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "PERMISSION_DENIED";

/**
 * Bodies the permission helpers answer 403 with. "Forbidden" is what ships
 * today (auth-helpers.ts requirePermission / requirePermissionWithBranch /
 * requirePermissionAudited); the other two are accepted so a future rename to
 * a machine code does not silently turn banners back into raw errors.
 */
const PERMISSION_DENIED_CODES = new Set(["Forbidden", "FORBIDDEN", "PERMISSION_DENIED"]);

/** Null for every response that is not one of the four walls. */
export function blockedCodeOf(status: number | null, code: string | null): BlockedCode | null {
  if (status === 402) return "SUBSCRIPTION_REQUIRED";
  if (status !== 403) return null;
  if (code === "TENANT_SUSPENDED") return "TENANT_SUSPENDED";
  if (code === "PASSWORD_CHANGE_REQUIRED") return "PASSWORD_CHANGE_REQUIRED";
  // NO_BRANCH_ACCESS / FORBIDDEN_BRANCH are branch-selection problems, not
  // permission denials — they fall through to null on purpose.
  if (code && PERMISSION_DENIED_CODES.has(code)) return "PERMISSION_DENIED";
  return null;
}
