/**
 * F8 — reliability layer tests.
 *
 * Verifies retry policy, provider fallback policy, bounded attempts, deadline
 * handling, and classification of ProviderError kinds. Uses deterministic
 * in-memory MockProvider doubles — no live Gemini / Groq calls.
 */
import { describe, expect, it } from "vitest";

import {
  ProviderError,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type ProviderName,
} from "@/lib/ai/providers";
import {
  backoffMs,
  buildProviderPool,
  callWithReliability,
  isFallbackEligible,
  isPermanent,
  isRetryableTransient,
  MAX_PROVIDER_ATTEMPTS,
  MAX_RETRIES_PER_PROVIDER,
} from "@/lib/ai/reliability";
import { startRun } from "@/lib/ai/telemetry";

/* ───────────────────────── mock provider ─────────────────────────────── */

class MockProvider implements AIProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;
  /** Script of outcomes. "ok" → success; a ProviderError kind → throw. */
  script: Array<"ok" | ProviderError["kind"]>;
  attempts = 0;

  constructor(
    name: ProviderName,
    model: string,
    script: Array<"ok" | ProviderError["kind"]>,
  ) {
    this.name = name;
    this.defaultModel = model;
    this.script = [...script];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    this.attempts += 1;
    const next = this.script.shift() ?? "ok";
    if (next === "ok") {
      return {
        content: "",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        provider: this.name,
        model: this.defaultModel,
      };
    }
    throw new ProviderError({
      kind: next,
      provider: this.name,
      message: `mock_${next}`,
    });
  }

  async healthCheck() {
    return { ok: true as const, model: this.defaultModel };
  }
}

function fakeRun() {
  return startRun({ tenantId: "t", userId: "u", branchId: null, locale: "en" });
}

function noSleep(_ms: number): Promise<void> {
  return Promise.resolve();
}

const BLANK_REQUEST: ChatRequest = {
  system: "",
  messages: [],
  tools: [],
};

/* ───────────────────────── classification ─────────────────────────────── */

describe("isRetryableTransient", () => {
  it.each([
    ["rate_limit", true],
    ["overloaded", true],
    ["timeout", true],
    ["network", true],
    ["tool_use_failed", true],
    ["auth", false],
    ["invalid_request", false],
    ["server", false],
    ["unknown", false],
  ] as const)("ProviderError.kind=%s → %s", (kind, expected) => {
    const e = new ProviderError({ kind, provider: "gemini", message: "" });
    expect(isRetryableTransient(e)).toBe(expected);
  });

  it("non-ProviderError is never retryable", () => {
    expect(isRetryableTransient(new Error("boom"))).toBe(false);
  });
});

describe("isPermanent", () => {
  it.each([
    ["auth", true],
    ["invalid_request", true],
    ["rate_limit", false],
    ["overloaded", false],
    ["timeout", false],
    ["network", false],
    ["tool_use_failed", false],
    ["server", false],
    ["unknown", false],
  ] as const)("ProviderError.kind=%s → %s", (kind, expected) => {
    const e = new ProviderError({ kind, provider: "gemini", message: "" });
    expect(isPermanent(e)).toBe(expected);
  });
});

describe("isFallbackEligible", () => {
  it.each([
    ["rate_limit", true],
    ["overloaded", true],
    ["timeout", true],
    ["network", true],
    ["server", true],
    ["tool_use_failed", false], // bad model output — new provider won't help
    ["auth", false],
    ["invalid_request", false],
  ] as const)("ProviderError.kind=%s → %s", (kind, expected) => {
    const e = new ProviderError({ kind, provider: "gemini", message: "" });
    expect(isFallbackEligible(e)).toBe(expected);
  });
});

/* ───────────────────────── backoffMs ─────────────────────────────────── */

describe("backoffMs", () => {
  it("respects a provider retryAfterMs hint exactly", () => {
    const e = new ProviderError({ kind: "rate_limit", provider: "gemini", message: "", retryAfterMs: 1234 });
    expect(backoffMs(0, e)).toBe(1234);
    expect(backoffMs(5, e)).toBe(1234);
  });

  it("without a hint, grows exponentially bounded by MAX_BACKOFF_MS", () => {
    const e = new ProviderError({ kind: "overloaded", provider: "gemini", message: "" });
    // Not deterministic (jitter), but bounded.
    for (let i = 0; i < 10; i++) {
      const b = backoffMs(i, e);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(20_000);
    }
  });
});

/* ───────────────────────── orchestrator ──────────────────────────────── */

describe("callWithReliability — single provider", () => {
  it("success on first attempt — no retry, no fallback", async () => {
    const p = new MockProvider("gemini", "g", ["ok"]);
    const run = fakeRun();
    const res = await callWithReliability({
      providers: [p],
      request: BLANK_REQUEST,
      telemetry: run,
      sleep: noSleep,
    });
    expect(res.provider).toBe("gemini");
    expect(run.retryCount).toBe(0);
    expect(run.fallbackUsed).toBe(false);
    expect(run.providerAttempts).toHaveLength(1);
    expect(run.providerAttempts[0]!.result).toBe("success");
  });

  it("bounded retries on transient failure, then success", async () => {
    const p = new MockProvider("gemini", "g", ["rate_limit", "rate_limit", "ok"]);
    const run = fakeRun();
    const res = await callWithReliability({
      providers: [p],
      request: BLANK_REQUEST,
      telemetry: run,
      sleep: noSleep,
    });
    expect(res.provider).toBe("gemini");
    expect(run.retryCount).toBe(2);
    expect(run.providerAttempts).toHaveLength(3);
  });

  it("bounded retries exhausted → throws last error", async () => {
    const p = new MockProvider("gemini", "g", Array(MAX_RETRIES_PER_PROVIDER + 1).fill("overloaded"));
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [p],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toThrow();
    expect(run.providerAttempts).toHaveLength(MAX_RETRIES_PER_PROVIDER + 1);
    expect(run.retryCount).toBe(MAX_RETRIES_PER_PROVIDER);
  });

  it("permanent error → throws immediately, no retries", async () => {
    const p = new MockProvider("gemini", "g", ["auth"]);
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [p],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(run.providerAttempts).toHaveLength(1);
    expect(run.retryCount).toBe(0);
  });

  it("invalid_request → throws immediately, no retries", async () => {
    const p = new MockProvider("gemini", "g", ["invalid_request"]);
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [p],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(run.providerAttempts).toHaveLength(1);
  });
});

describe("callWithReliability — fallback", () => {
  it("primary exhausts transients → fallback succeeds", async () => {
    const primary = new MockProvider(
      "gemini",
      "g",
      Array(MAX_RETRIES_PER_PROVIDER + 1).fill("overloaded"),
    );
    const secondary = new MockProvider("groq", "k", ["ok"]);
    const run = fakeRun();
    const res = await callWithReliability({
      providers: [primary, secondary],
      request: BLANK_REQUEST,
      telemetry: run,
      sleep: noSleep,
    });
    expect(res.provider).toBe("groq");
    expect(run.fallbackUsed).toBe(true);
    expect(run.providerAttempts.map((a) => a.result)).toEqual([
      "overloaded", "overloaded", "overloaded", "overloaded", "success",
    ]);
    // Total provider attempts bounded.
    const distinctProviders = new Set(run.providerAttempts.map((a) => a.provider));
    expect(distinctProviders.size).toBeLessThanOrEqual(MAX_PROVIDER_ATTEMPTS);
  });

  it("primary permanent error → no fallback", async () => {
    const primary = new MockProvider("gemini", "g", ["auth"]);
    const secondary = new MockProvider("groq", "k", ["ok"]);
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [primary, secondary],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(secondary.attempts).toBe(0);
    expect(run.fallbackUsed).toBe(false);
  });

  it("primary invalid_request → no fallback", async () => {
    const primary = new MockProvider("gemini", "g", ["invalid_request"]);
    const secondary = new MockProvider("groq", "k", ["ok"]);
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [primary, secondary],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(secondary.attempts).toBe(0);
  });

  it("primary tool_use_failed → retries, no fallback (fallback not eligible)", async () => {
    const primary = new MockProvider(
      "gemini",
      "g",
      Array(MAX_RETRIES_PER_PROVIDER + 1).fill("tool_use_failed"),
    );
    const secondary = new MockProvider("groq", "k", ["ok"]);
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [primary, secondary],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: "tool_use_failed" });
    expect(secondary.attempts).toBe(0);
  });

  it("both providers fail → throws last error", async () => {
    const primary = new MockProvider(
      "gemini",
      "g",
      Array(MAX_RETRIES_PER_PROVIDER + 1).fill("overloaded"),
    );
    const secondary = new MockProvider(
      "groq",
      "k",
      Array(MAX_RETRIES_PER_PROVIDER + 1).fill("overloaded"),
    );
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [primary, secondary],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: "overloaded" });
    expect(run.fallbackUsed).toBe(true);
  });

  it("MAX_PROVIDER_ATTEMPTS caps the pool regardless of input length", async () => {
    // Even if someone passes 5 providers, only MAX are tried.
    const providers = Array(5)
      .fill(0)
      .map((_, i) =>
        new MockProvider("gemini", `m${i}`, Array(MAX_RETRIES_PER_PROVIDER + 1).fill("overloaded")),
      );
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers,
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
      }),
    ).rejects.toThrow();
    const distinct = new Set(run.providerAttempts.map((a) => a.model));
    expect(distinct.size).toBeLessThanOrEqual(MAX_PROVIDER_ATTEMPTS);
  });
});

describe("callWithReliability — deadlines", () => {
  it("stops before starting a new attempt when past the deadline", async () => {
    const p = new MockProvider("gemini", "g", ["overloaded", "overloaded", "ok"]);
    const run = fakeRun();
    await expect(
      callWithReliability({
        providers: [p],
        request: BLANK_REQUEST,
        telemetry: run,
        sleep: noSleep,
        deadlineAt: Date.now() - 1, // already expired
      }),
    ).rejects.toThrow();
    // At most one attempt was issued before we gave up.
    expect(run.providerAttempts.length).toBeLessThanOrEqual(1);
  });
});

/* ───────────────────────── provider pool helper ──────────────────────── */

describe("buildProviderPool", () => {
  it("returns [primary] when no secondary", () => {
    const primary = new MockProvider("gemini", "g", []);
    const pool = buildProviderPool({ primary, secondary: null });
    expect(pool).toHaveLength(1);
  });

  it("returns [primary, secondary] when different names", () => {
    const primary = new MockProvider("gemini", "g", []);
    const secondary = new MockProvider("groq", "k", []);
    const pool = buildProviderPool({ primary, secondary });
    expect(pool).toHaveLength(2);
    expect(pool[0]!.name).toBe("gemini");
    expect(pool[1]!.name).toBe("groq");
  });

  it("deduplicates when both are the same provider", () => {
    const primary = new MockProvider("gemini", "g", []);
    const secondary = new MockProvider("gemini", "g2", []);
    const pool = buildProviderPool({ primary, secondary });
    expect(pool).toHaveLength(1);
  });
});
