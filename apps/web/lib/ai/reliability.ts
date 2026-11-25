import {
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  ProviderError,
  type ProviderName,
} from "./providers";
import {
  type AiRunRecord,
  recordFallback,
  recordProviderAttempt,
  recordRetry,
} from "./telemetry";

/**
 * F8 — Centralized retry + provider fallback policy.
 *
 * Policy (approved for F8):
 *   • Each provider gets at most MAX_RETRIES_PER_PROVIDER attempts for a
 *     classified transient error. Exponential backoff with full jitter,
 *     clamped to MAX_BACKOFF_MS.
 *   • If a provider still fails with a fallback-eligible error after its
 *     retry budget, orchestrator moves to the next provider ONCE. Total
 *     provider attempts are bounded by MAX_PROVIDER_ATTEMPTS.
 *   • Permanent errors (auth, invalid_request) skip retries AND skip
 *     fallback — they're bugs or configuration issues, not transient.
 *   • Deadline-aware: once `deadlineAt` is passed, the orchestrator returns
 *     the last error immediately rather than starting another attempt.
 *
 * The orchestrator never calls providers in parallel (that would magnify
 * rate-limit spending). Fallback is strictly after primary fails.
 *
 * SECURITY — fallback does NOT change the ChatRequest, the tool registry,
 * or the agent's grounding/F5/F6/F7 invariants. The provider is the only
 * thing swapped. All security checks run per-tool-call and are unaffected.
 */

export const MAX_RETRIES_PER_PROVIDER = 3;
export const MAX_PROVIDER_ATTEMPTS = 2; // primary + 1 fallback
export const MAX_BACKOFF_MS = 20_000;

/* ───────────────────────── classification ─────────────────────────────── */

/**
 * Transient errors retry on the SAME provider. Each ProviderError.kind maps
 * here deterministically; anything else is non-retryable by definition.
 */
export function isRetryableTransient(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return (
    err.kind === "rate_limit" ||
    err.kind === "overloaded" ||
    err.kind === "timeout" ||
    err.kind === "network" ||
    err.kind === "tool_use_failed"
  );
}

/**
 * A fallback-eligible error moves us to the NEXT provider once the primary's
 * retry budget is exhausted. `tool_use_failed` is deliberately excluded —
 * the model emitted bad JSON; switching providers won't help and may waste
 * a second budget before the user sees the problem.
 */
export function isFallbackEligible(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return (
    err.kind === "rate_limit" ||
    err.kind === "overloaded" ||
    err.kind === "timeout" ||
    err.kind === "network" ||
    err.kind === "server"
  );
}

/**
 * Permanent errors — never retry, never fallback. Surface them immediately.
 */
export function isPermanent(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return err.kind === "auth" || err.kind === "invalid_request";
}

/* ───────────────────────── backoff helpers ────────────────────────────── */

/** Exponential backoff with full jitter, capped at MAX_BACKOFF_MS.
 *  attempt is 0-based (0 for the first retry). */
export function backoffMs(attempt: number, err: unknown): number {
  const hint = err instanceof ProviderError ? err.retryAfterMs : null;
  if (hint && Number.isFinite(hint)) {
    // Respect provider hint exactly (no jitter) — Groq / Gemini hints are
    // authoritative and jittering them wastes the budget they bought us.
    return Math.min(MAX_BACKOFF_MS, Math.max(0, hint));
  }
  const base = 400 * Math.pow(2, attempt); // 400, 800, 1600 …
  const jittered = Math.random() * base;
  return Math.min(MAX_BACKOFF_MS, Math.floor(jittered));
}

/* ───────────────────────── orchestrator ───────────────────────────────── */

export interface CallWithReliabilityInput {
  providers: AIProvider[]; // ordered: [primary, fallback?, …]
  request: ChatRequest;
  telemetry: AiRunRecord;
  /** Absolute deadline (ms since epoch). After this we stop new attempts. */
  deadlineAt?: number;
  /** Test hook — swap setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Attempt the request with the first provider, retry it on classified
 * transient errors, and fall back to the next provider on fallback-eligible
 * failures. Records every attempt in the telemetry record.
 *
 * Throws the LAST provider error once every attempt is exhausted. On success
 * returns the ChatResponse unchanged.
 */
export async function callWithReliability(
  input: CallWithReliabilityInput,
): Promise<ChatResponse> {
  const sleep = input.sleep ?? defaultSleep;
  const providers = input.providers.slice(0, MAX_PROVIDER_ATTEMPTS);
  if (providers.length === 0) throw new Error("No providers configured");

  let lastErr: unknown;

  for (let p = 0; p < providers.length; p++) {
    const provider = providers[p]!;
    const isFallback = p > 0;
    if (isFallback) recordFallback(input.telemetry);

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      if (input.deadlineAt && Date.now() >= input.deadlineAt) {
        // Fast-fail the moment we're past the request budget.
        if (lastErr) throw lastErr;
        throw new Error("deadline_exceeded_before_first_attempt");
      }

      const start = Date.now();
      try {
        const res = await provider.chat({
          ...input.request,
          // Clamp per-call timeout to whatever's left of our deadline so we
          // don't wait longer than the whole request has budget for.
          timeoutMs: computeCallTimeout(input.request.timeoutMs, input.deadlineAt),
        });
        recordProviderAttempt(input.telemetry, {
          provider: provider.name,
          model: res.model ?? provider.defaultModel,
          durationMs: Date.now() - start,
          result: "success",
        });
        input.telemetry.finalProvider = provider.name;
        input.telemetry.finalModel = res.model ?? provider.defaultModel;
        return res;
      } catch (err) {
        lastErr = err;
        const kind = err instanceof ProviderError ? err.kind : "unknown";
        recordProviderAttempt(input.telemetry, {
          provider: provider.name,
          model: provider.defaultModel,
          durationMs: Date.now() - start,
          result: kind,
          retryAfterMs:
            err instanceof ProviderError && err.retryAfterMs != null
              ? err.retryAfterMs
              : null,
        });

        // Permanent — never retry, never fallback.
        if (isPermanent(err)) throw err;

        // A non-provider error → re-throw; the agent treats it as a bug.
        if (!(err instanceof ProviderError)) throw err;

        // Transient — retry the SAME provider if we have budget.
        if (isRetryableTransient(err) && attempt < MAX_RETRIES_PER_PROVIDER) {
          recordRetry(input.telemetry);
          const waitMs = backoffMs(attempt, err);
          if (input.deadlineAt && Date.now() + waitMs >= input.deadlineAt) {
            // Not enough budget to even wait for the backoff — treat as
            // exhausted on this provider; try fallback or give up.
            break;
          }
          await sleep(waitMs);
          continue;
        }

        // Retries exhausted (or non-retryable but not permanent) → consider
        // fallback. If this provider isn't fallback-eligible, bubble up.
        if (!isFallbackEligible(err)) throw err;
        // Fall through to the next provider in the outer loop.
        break;
      }
    }
  }

  // Every provider exhausted.
  if (lastErr) throw lastErr;
  throw new Error("no_provider_attempts_recorded");
}

/* ───────────────────────── helpers ────────────────────────────────────── */

function computeCallTimeout(
  requested: number | undefined,
  deadlineAt: number | undefined,
): number | undefined {
  if (!deadlineAt) return requested;
  const remaining = Math.max(0, deadlineAt - Date.now());
  if (!requested) return remaining;
  return Math.min(requested, remaining);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ───────────────────────── provider pool ──────────────────────────────── */

/**
 * Build the ordered [primary, fallback] pool from env. AI_PROVIDER picks the
 * primary; the other one, if its key is set, is the fallback.
 *
 * Returns ONLY providers whose keys are configured — the caller only sees a
 * one-element list in dev / single-key environments, and fallback is a no-op.
 */
export function buildProviderPool(opts: {
  primary: AIProvider;
  secondary?: AIProvider | null;
}): AIProvider[] {
  const pool: AIProvider[] = [opts.primary];
  if (opts.secondary && opts.secondary.name !== opts.primary.name) {
    pool.push(opts.secondary);
  }
  return pool.slice(0, MAX_PROVIDER_ATTEMPTS);
}

export type { ProviderName };
