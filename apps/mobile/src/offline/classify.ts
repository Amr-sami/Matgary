/**
 * Pure decision logic for the outbox — no imports with side effects, so
 * `node --test --experimental-strip-types` can run it (see __tests__/).
 *
 * The web's drain treated every 4xx as terminal and had no backoff
 * (doc 06 §6.3 defects 1 and 2). Here every decision is made on
 * `ApiError.kind` / `.code`, never on the status class.
 */
import type { ApiErrorKind } from "@matgary/api-client";

/** What the drainer does with a row after one attempt threw. */
export type Outcome =
  /** The server already has it (409 idempotent replay). Mark done. */
  | { kind: "done" }
  /** Never reached the server, or it never answered. Back off and retry. */
  | { kind: "retryable-network"; delayMs: number }
  /**
   * Reached the server and it failed (5xx / 429 / proxy page). Back off and
   * retry. `rateLimited` (429): the verdict is on the whole flush, so the
   * drainer defers EVERY queued row past Retry-After and stops (§6.3).
   */
  | { kind: "retryable-server"; delayMs: number; rateLimited?: boolean }
  /** Session, billing wall, or TOTP. Leave the row queued and stop draining. */
  | { kind: "auth-wait" }
  /** A 4xx that a retry cannot fix. Keep the row as `failed` for a human. */
  | {
      kind: "terminal-failure";
      /** True when the CASHIER can resolve it (stock, product, branch). */
      actionable: boolean;
      code: string | null;
      message: string;
    };

/** The structural shape of ApiError — duck-typed so tests need no RN imports. */
export interface ErrorLike {
  kind: ApiErrorKind;
  code: string | null;
  status: number | null;
  retryAfterSec: number | null;
  message: string;
}

/** Errors the cashier, not an engineer, has the information to resolve (§6.3). */
export const USER_ACTIONABLE_CODES: ReadonlySet<string> = new Set([
  "INSUFFICIENT_STOCK",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_WRONG_BRANCH",
  "BRANCH_MISMATCH",
]);

/** 409 codes that mean "already recorded under this idempotency key". */
export const REPLAY_CODES: ReadonlySet<string> = new Set([
  "IDEMPOTENT_REPLAY",
  "DUPLICATE",
  "DUPLICATE_REQUEST",
  "ALREADY_EXISTS",
  "ALREADY_RECORDED",
  "ALREADY_PROCESSED",
]);

/** Backoff ceiling. The brief caps at 5 minutes; doc 06 suggested 15. */
export const MAX_BACKOFF_MS = 5 * 60_000;
export const BASE_BACKOFF_MS = 1_000;

/** True when `e` quacks like ApiError. Anything else is treated as `unknown`. */
export function isErrorLike(e: unknown): e is ErrorLike {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string" &&
    "code" in e
  );
}

/**
 * `min(2^attempts * base + jitter, cap)`. `attempts` is the count AFTER the
 * failed try (1 on the first failure). Jitter is up to one base unit so a
 * burst of rows queued together does not re-fire in lockstep. `rand` is
 * injectable for tests; defaults to Math.random.
 */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.min(attempts, 30));
  const exp = Math.min(2 ** (n - 1) * BASE_BACKOFF_MS, MAX_BACKOFF_MS);
  const jitter = Math.floor(rand() * BASE_BACKOFF_MS);
  return Math.min(exp + jitter, MAX_BACKOFF_MS);
}

/**
 * Decide what to do with a row after `err` was thrown by its handler.
 * `attempts` is the value already incremented for this failure.
 */
export function classifyOutcome(
  err: unknown,
  attempts: number,
  rand: () => number = Math.random,
): Outcome {
  if (!isErrorLike(err)) {
    // A programming error inside a handler (TypeError …) is not a network
    // problem — but neither is it something the cashier can act on, and
    // dropping the row is forbidden. Retry with backoff; a human can
    // discard it from the queue screen if it never clears.
    return { kind: "retryable-server", delayMs: backoffMs(attempts, rand) };
  }

  switch (err.kind) {
    case "offline":
    case "timeout":
      return { kind: "retryable-network", delayMs: backoffMs(attempts, rand) };

    case "rateLimited": {
      // Honour Retry-After (doc 06 §6.3 defect 2) — the limiter window is
      // 60s; a blind exponential curve would under- or over-shoot it.
      const ra = err.retryAfterSec != null && err.retryAfterSec > 0 ? err.retryAfterSec * 1000 : null;
      const delayMs = ra != null ? Math.min(ra + Math.floor(rand() * 500), MAX_BACKOFF_MS) : backoffMs(attempts, rand);
      return { kind: "retryable-server", delayMs, rateLimited: true };
    }

    case "server":
    case "unknown":
      return { kind: "retryable-server", delayMs: backoffMs(attempts, rand) };

    case "session":
    case "credentials":
    case "billing":
      return { kind: "auth-wait" };

    case "conflict":
      if (err.code && REPLAY_CODES.has(err.code)) return { kind: "done" };
      if (err.code === "TOTP_REQUIRED") return { kind: "auth-wait" };
      return terminal(err, err.code === "BRANCH_MISMATCH" || isBranchMismatchMessage(err.message));

    case "validation":
      return terminal(err, err.code != null && USER_ACTIONABLE_CODES.has(err.code));

    case "notFound":
    case "forbidden":
      return terminal(err, false);
  }
}

function terminal(err: ErrorLike, actionable: boolean): Outcome {
  return {
    kind: "terminal-failure",
    actionable,
    code: err.code,
    message: err.message,
  };
}

/**
 * The cart route's branch-mismatch 409 carries an Arabic sentence and no
 * machine code (apps/web/app/api/sales/cart/route.ts). Recognise it so the
 * queue screen can offer "switch branch" rather than a generic failure.
 */
function isBranchMismatchMessage(message: string): boolean {
  return /فرع آخر|branch/i.test(message);
}
