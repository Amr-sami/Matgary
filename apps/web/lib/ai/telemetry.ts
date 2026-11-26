import { randomUUID } from "node:crypto";

import type { Locale } from "./responses";

/**
 * F8 — AI run telemetry.
 *
 * One `AiRunRecord` per AI request. Populated incrementally during the run,
 * emitted as a single structured JSON log line at the end. In-memory metrics
 * aggregate across the process lifetime for the `/api/ai/metrics` endpoint.
 *
 * SAFETY — redaction:
 *   • The record NEVER captures API keys, HMAC secrets, confirmation tokens,
 *     full tool arguments, or raw provider error payloads.
 *   • Tool names + categorical outcomes only. Arguments are summarized to a
 *     byte count, never serialized. Error messages pass through `redactError`
 *     which strips anything that looks like a token.
 *   • Tenant/user/branch ids follow existing project logging conventions.
 *
 * COST — every helper is synchronous + in-memory. No DB writes, no Redis
 * round-trips, no extra provider calls. Logging is one `console.info` at the
 * end of the request.
 */

/* ───────────────────────────── types ──────────────────────────────────── */

export type FinalResponseKind =
  | "blocks"           // normal success — one or more AiBlocks returned
  | "fast_path"        // trivial-greeting short-circuit, no model call
  | "capped"           // MAX_ROUNDS hit; fallback text returned
  | "provider_failed"  // all providers exhausted
  | "invalid_request"
  | "auth_failed"
  | "ai_disabled";

export type FailureCategory =
  | "provider_rate_limit"
  | "provider_overloaded"
  | "provider_timeout"
  | "provider_network"
  | "provider_auth"
  | "provider_invalid_request"
  | "provider_tool_use_failed"
  | "provider_server"
  | "provider_unknown"
  | "db_timeout"
  | "db_unavailable"
  | "redis_degraded"
  | "tool_failed"
  | "grounding_dropped_all"
  | "unknown";

export interface ProviderAttemptRecord {
  provider: string;
  model: string;
  startedAt: string; // ISO
  durationMs: number;
  result: "success" | "rate_limit" | "overloaded" | "timeout" | "tool_use_failed" | "invalid_request" | "auth" | "network" | "server" | "unknown";
  retryAfterMs?: number | null;
}

export interface ToolCallRecord {
  name: string;
  durationMs: number;
  /** Byte length of the args JSON. Never the args themselves — they can carry
   *  customer PII (phone numbers) or price values we don't need in telemetry. */
  argBytes: number;
  ok: boolean;
  errorKind?: string;
}

export interface AiRunRecord {
  requestId: string;
  conversationId: string | null;
  tenantId: string;
  userId: string;
  branchId: string | null;
  locale: Locale;

  startedAt: string;
  durationMs: number;

  roundsUsed: number;
  providerAttempts: ProviderAttemptRecord[];
  retryCount: number;
  fallbackUsed: boolean;
  finalProvider: string | null;
  finalModel: string | null;

  toolCalls: ToolCallRecord[];
  blockCount: number;
  blockKinds: string[];

  /** F6 observability. */
  contextActive: boolean;
  contextHit: boolean;
  redisDegraded: boolean;
  referenceResolution: "resolved" | "ambiguous" | "unresolved" | null;

  /** F3 observability. */
  groundingDrops: number;

  /** F7 observability. */
  localeDrift: boolean;
  missingI18nKeys: string[];

  usage: { promptTokens: number; completionTokens: number; totalTokens: number };

  completion: "success" | "failure";
  finalResponseKind: FinalResponseKind | null;
  failureCategory: FailureCategory | null;
}

/* ───────────────────────────── builder ────────────────────────────────── */

export interface StartRunInput {
  requestId?: string;
  conversationId?: string | null;
  tenantId: string;
  userId: string;
  branchId: string | null;
  locale: Locale;
}

export function startRun(input: StartRunInput): AiRunRecord {
  return {
    requestId: input.requestId ?? newRequestId(),
    conversationId: input.conversationId ?? null,
    tenantId: input.tenantId,
    userId: input.userId,
    branchId: input.branchId,
    locale: input.locale,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    roundsUsed: 0,
    providerAttempts: [],
    retryCount: 0,
    fallbackUsed: false,
    finalProvider: null,
    finalModel: null,
    toolCalls: [],
    blockCount: 0,
    blockKinds: [],
    contextActive: false,
    contextHit: false,
    redisDegraded: false,
    referenceResolution: null,
    groundingDrops: 0,
    localeDrift: false,
    missingI18nKeys: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    completion: "failure",
    finalResponseKind: null,
    failureCategory: null,
  };
}

/** Finalize the run, emit a structured log line, update aggregate metrics.
 *  Caller does not need to log separately. */
export function finishRun(record: AiRunRecord): AiRunRecord {
  record.durationMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
  metrics.ingest(record);
  // One structured line. JSON.stringify does not expand nested arrays beyond
  // what's already in the record — nothing here should be a secret by design.
  try {
    console.info("[ai/run]", JSON.stringify(record));
  } catch {
    /* non-fatal — a telemetry log should never break the request */
  }
  return record;
}

/* ───────────────────────── recording helpers ──────────────────────────── */

export function recordProviderAttempt(
  record: AiRunRecord,
  attempt: Omit<ProviderAttemptRecord, "startedAt"> & { startedAt?: string },
): void {
  record.providerAttempts.push({
    ...attempt,
    startedAt: attempt.startedAt ?? new Date().toISOString(),
  });
}

export function recordRetry(record: AiRunRecord): void {
  record.retryCount += 1;
}

export function recordFallback(record: AiRunRecord): void {
  record.fallbackUsed = true;
}

export function recordToolCall(record: AiRunRecord, call: ToolCallRecord): void {
  record.toolCalls.push(call);
}

export function recordRedisDegradation(record: AiRunRecord, reason: string): void {
  if (!record.redisDegraded) {
    record.redisDegraded = true;
    metrics.counters.redisDegradations += 1;
    console.warn("[ai/run] redis_degraded", { requestId: record.requestId, reason });
  }
}

export function recordGroundingDrop(record: AiRunRecord, n = 1): void {
  record.groundingDrops += n;
  metrics.counters.groundingDrops += n;
}

export function recordLocaleDrift(record: AiRunRecord): void {
  record.localeDrift = true;
  metrics.counters.localeDrifts += 1;
}

export function recordMissingI18n(record: AiRunRecord, key: string): void {
  if (!record.missingI18nKeys.includes(key)) {
    record.missingI18nKeys.push(key);
    metrics.counters.missingI18nKeys += 1;
  }
}

/* ───────────────────────── redaction helpers ──────────────────────────── */

/**
 * Convert an arbitrary error into a short, safe string for logging. Strips
 * anything that looks like a token (long hex sequences, uuid-like strings
 * next to the word "token"), API-key-shaped values, and limits length.
 */
export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  let out = raw;
  // JWT-ish three-part tokens.
  out = out.replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "<redacted-jwt>");
  // Confirmation tokens: uuid.hmac64 shape (F5).
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{40,}/gi, "<redacted-pending-token>");
  // Standalone 40+-hex hmacs.
  out = out.replace(/\b[0-9a-f]{40,}\b/gi, "<redacted-hmac>");
  // Common provider SDK keys / header leaks.
  out = out.replace(/\b(sk|gsk|key|api[_-]?key|authorization)[_=:-][A-Za-z0-9._\-]{8,}/gi, "<redacted-key>");
  if (out.length > 400) out = `${out.slice(0, 400)}…`;
  return out;
}

/* ───────────────────────── request id ─────────────────────────────────── */

/** Server-side requestId. We never trust a client-provided value for anything
 *  that could affect authorization; the client may read `X-Ai-Request-Id` on
 *  the response to cross-reference logs. */
export function newRequestId(): string {
  return `ai_${randomUUID()}`;
}

/* ───────────────────────── in-memory metrics ──────────────────────────── */

const LATENCY_WINDOW = 500;
const RECENT_WINDOW_MS = 60_000;

class Metrics {
  readonly counters = {
    runs: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    fallbacks: 0,
    rateLimits: 0,
    overloaded: 0,
    timeouts: 0,
    authFailures: 0,
    invalidRequests: 0,
    groundingDrops: 0,
    redisDegradations: 0,
    localeDrifts: 0,
    missingI18nKeys: 0,
    confirmationRejects: 0,
    auditFailures: 0,
  };

  /** Ring buffer of recent run durations (ms). */
  private latencies: number[] = [];
  /** Ring of recent run timestamps for rate calculations. */
  private recentAt: number[] = [];

  ingest(record: AiRunRecord): void {
    this.counters.runs += 1;
    if (record.completion === "success") this.counters.successes += 1;
    else this.counters.failures += 1;
    this.counters.retries += record.retryCount;
    if (record.fallbackUsed) this.counters.fallbacks += 1;

    for (const a of record.providerAttempts) {
      if (a.result === "rate_limit") this.counters.rateLimits += 1;
      if (a.result === "overloaded") this.counters.overloaded += 1;
      if (a.result === "timeout") this.counters.timeouts += 1;
      if (a.result === "auth") this.counters.authFailures += 1;
      if (a.result === "invalid_request") this.counters.invalidRequests += 1;
    }

    this.latencies.push(record.durationMs);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();

    this.recentAt.push(Date.now());
    // Drop stale entries lazily — only on ingest.
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    while (this.recentAt.length > 0 && this.recentAt[0]! < cutoff) this.recentAt.shift();
  }

  requestsPerMinute(): number {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return this.recentAt.filter((t) => t >= cutoff).length;
  }

  percentiles(): { p50: number; p95: number; p99: number; count: number } {
    if (this.latencies.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (p: number): number => {
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
      return sorted[idx]!;
    };
    return { p50: pick(50), p95: pick(95), p99: pick(99), count: sorted.length };
  }

  snapshot(): {
    counters: Metrics["counters"];
    percentiles: ReturnType<Metrics["percentiles"]>;
    requestsPerMinute: number;
    sampleWindow: number;
  } {
    return {
      counters: { ...this.counters },
      percentiles: this.percentiles(),
      requestsPerMinute: this.requestsPerMinute(),
      sampleWindow: LATENCY_WINDOW,
    };
  }

  /** Test-only — reset counters + windows between failure-injection cases. */
  reset(): void {
    for (const k of Object.keys(this.counters) as Array<keyof Metrics["counters"]>) {
      this.counters[k] = 0;
    }
    this.latencies = [];
    this.recentAt = [];
  }
}

export const metrics = new Metrics();

/** Convenience for the confirm route + executor, which don't go through
 *  runAgent but still want their failure signals to show up in metrics. */
export function bumpConfirmationReject(): void {
  metrics.counters.confirmationRejects += 1;
}
export function bumpAuditFailure(): void {
  metrics.counters.auditFailures += 1;
}
