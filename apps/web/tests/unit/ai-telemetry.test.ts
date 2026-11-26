/**
 * F8 — telemetry module tests.
 *
 * Covers:
 *   • Run record shape + lifecycle (start → helpers → finish).
 *   • Redaction: JWTs, pending-action tokens, HMAC-looking strings,
 *     "api_key=..." leaks are all scrubbed.
 *   • Metrics aggregator: counters increment on ingest; percentiles behave
 *     sensibly with a known latency distribution.
 *   • finishRun logs exactly one structured [ai/run] line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bumpAuditFailure,
  bumpConfirmationReject,
  finishRun,
  metrics,
  newRequestId,
  recordFallback,
  recordGroundingDrop,
  recordLocaleDrift,
  recordProviderAttempt,
  recordRedisDegradation,
  recordRetry,
  recordToolCall,
  redactError,
  startRun,
} from "@/lib/ai/telemetry";

describe("startRun", () => {
  it("creates a minimally-correct run record", () => {
    const r = startRun({
      tenantId: "t-1",
      userId: "u-1",
      branchId: null,
      locale: "en",
    });
    expect(r.requestId).toMatch(/^ai_[0-9a-f-]{36}$/);
    expect(r.completion).toBe("failure"); // default — flipped on finish
    expect(r.providerAttempts).toHaveLength(0);
    expect(r.retryCount).toBe(0);
    expect(r.fallbackUsed).toBe(false);
    expect(r.contextActive).toBe(false);
  });

  it("honors a caller-supplied requestId", () => {
    const r = startRun({
      requestId: "my-rid",
      tenantId: "t-1",
      userId: "u-1",
      branchId: null,
      locale: "ar",
    });
    expect(r.requestId).toBe("my-rid");
  });
});

describe("recording helpers", () => {
  it("accumulates provider attempts, retries, fallback", () => {
    const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    recordProviderAttempt(r, { provider: "gemini", model: "g", durationMs: 10, result: "overloaded" });
    recordRetry(r);
    recordProviderAttempt(r, { provider: "gemini", model: "g", durationMs: 20, result: "overloaded" });
    recordFallback(r);
    recordProviderAttempt(r, { provider: "groq", model: "k", durationMs: 15, result: "success" });

    expect(r.providerAttempts).toHaveLength(3);
    expect(r.retryCount).toBe(1);
    expect(r.fallbackUsed).toBe(true);
  });

  it("recordRedisDegradation is idempotent per record", () => {
    metrics.reset();
    const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    recordRedisDegradation(r, "conn refused");
    recordRedisDegradation(r, "still bad");
    expect(r.redisDegraded).toBe(true);
    // Only the first call bumped the counter.
    expect(metrics.snapshot().counters.redisDegradations).toBe(1);
  });

  it("recordGroundingDrop + recordLocaleDrift update metrics + record", () => {
    metrics.reset();
    const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    recordGroundingDrop(r, 3);
    recordLocaleDrift(r);
    expect(r.groundingDrops).toBe(3);
    expect(r.localeDrift).toBe(true);
    expect(metrics.snapshot().counters.groundingDrops).toBe(3);
    expect(metrics.snapshot().counters.localeDrifts).toBe(1);
  });

  it("recordToolCall appends with byte budget, not full args", () => {
    const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    recordToolCall(r, { name: "search_products", durationMs: 42, argBytes: 123, ok: true });
    expect(r.toolCalls[0]!.argBytes).toBe(123);
    // Record shape does not store a raw args field — argBytes only.
    expect(Object.keys(r.toolCalls[0]!)).not.toContain("args");
  });
});

describe("redactError", () => {
  it("redacts a JWT-looking string", () => {
    const msg = redactError(
      new Error("provider returned: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef_-"),
    );
    expect(msg).toContain("<redacted-jwt>");
  });

  it("redacts a pending-action token (uuid.hmac64)", () => {
    const msg = redactError(
      new Error(
        "bad token: 00112233-4455-6677-8899-aabbccddeeff.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
    );
    expect(msg).toContain("<redacted-pending-token>");
    expect(msg).not.toMatch(/[0-9a-f]{40,}/);
  });

  it("redacts an 'api_key=sk-...' style leak", () => {
    const msg = redactError(new Error("Authorization: Bearer sk-abcdef1234567890"));
    expect(msg).toContain("<redacted-key>");
  });

  it("caps very long payloads", () => {
    const giant = "x".repeat(5000);
    const out = redactError(new Error(giant));
    expect(out.length).toBeLessThanOrEqual(401); // 400 + "…"
  });
});

describe("metrics aggregator", () => {
  beforeEach(() => metrics.reset());
  afterEach(() => metrics.reset());

  it("bumps counters per ingested record", () => {
    const r1 = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    recordProviderAttempt(r1, { provider: "gemini", model: "g", durationMs: 10, result: "rate_limit" });
    recordRetry(r1);
    r1.completion = "success";
    finishRun(r1);

    const r2 = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    recordProviderAttempt(r2, { provider: "gemini", model: "g", durationMs: 10, result: "overloaded" });
    recordFallback(r2);
    recordProviderAttempt(r2, { provider: "groq", model: "k", durationMs: 5, result: "success" });
    r2.completion = "success";
    finishRun(r2);

    const snap = metrics.snapshot();
    expect(snap.counters.runs).toBe(2);
    expect(snap.counters.successes).toBe(2);
    expect(snap.counters.failures).toBe(0);
    expect(snap.counters.retries).toBe(1);
    expect(snap.counters.fallbacks).toBe(1);
    expect(snap.counters.rateLimits).toBe(1);
    expect(snap.counters.overloaded).toBe(1);
  });

  it("percentiles across a known distribution", () => {
    for (let i = 1; i <= 100; i++) {
      const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
      // Manually set the duration by backdating startedAt.
      r.startedAt = new Date(Date.now() - i).toISOString();
      r.completion = "success";
      finishRun(r);
    }
    const p = metrics.snapshot().percentiles;
    expect(p.count).toBe(100);
    // p50 ~ 50, p95 ~ 95, p99 ~ 99 — allow small jitter from clock granularity.
    expect(p.p50).toBeGreaterThanOrEqual(45);
    expect(p.p50).toBeLessThanOrEqual(55);
    expect(p.p95).toBeGreaterThanOrEqual(90);
    expect(p.p99).toBeGreaterThanOrEqual(95);
  });
});

describe("finishRun side effects", () => {
  beforeEach(() => metrics.reset());

  it("emits exactly one structured [ai/run] log line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    r.completion = "success";
    finishRun(r);
    const runCalls = info.mock.calls.filter((c) => String(c[0]) === "[ai/run]");
    expect(runCalls).toHaveLength(1);
    const payload = runCalls[0]![1] as string;
    expect(() => JSON.parse(payload)).not.toThrow();
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.requestId).toBe(r.requestId);
    expect(parsed.completion).toBe("success");
    info.mockRestore();
  });

  it("never throws when console.info does", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("disk full");
    });
    const r = startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
    r.completion = "success";
    // Must not propagate.
    expect(() => finishRun(r)).not.toThrow();
    info.mockRestore();
  });
});

describe("standalone bumps", () => {
  beforeEach(() => metrics.reset());

  it("confirmation + audit bumps increment their counters", () => {
    bumpConfirmationReject();
    bumpConfirmationReject();
    bumpAuditFailure();
    const snap = metrics.snapshot();
    expect(snap.counters.confirmationRejects).toBe(2);
    expect(snap.counters.auditFailures).toBe(1);
  });
});

describe("newRequestId", () => {
  it("is unique per call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(newRequestId());
    expect(seen.size).toBe(20);
  });
});
