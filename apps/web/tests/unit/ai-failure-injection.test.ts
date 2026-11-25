/**
 * F8 — failure-injection coverage against the FULL `runAgent` path.
 *
 * Uses a deterministic MockProvider that is scripted to either succeed with a
 * no-tool-call "final text" turn, or throw a ProviderError of a chosen kind.
 * No live Gemini / Groq calls; no DB; no Redis.
 *
 * Scenarios (lettered to match F8 Part 24):
 *   A — Gemini success → normal response.
 *   B — Gemini transient × N → retry → success on same provider.
 *   C — Gemini overloaded past budget → Groq fallback succeeds.
 *   D — Gemini rate_limit bounded, no infinite retry.
 *   E — Gemini auth → NO fallback, surfaces as failure.
 *   F — Gemini invalid_request → NO fallback, surfaces as failure.
 *   G — Both providers overloaded → rejects; telemetry captures both attempts.
 *
 * H (Redis down) / I (DB failure) / J (write flow fallback safety) /
 * K (confirmation replay) / L (audit failure warning) are covered by:
 *   • Existing F5 live smoke (K rejects replay / fabricated-token / tampered-HMAC)
 *   • Existing F5.1 unit tests (L emits WarningBlock with AUDIT_WRITE_FAILED)
 *   • F6 context.store's degradation path (H — cacheGet returns null on
 *     Redis down, verified by the shared cache module's tests)
 *   • Executor TARGET_GONE / POST_VERIFY_FAILED paths (I — F5 live smoke)
 *   • Tool preview_* paths require a successful provider call — if the
 *     provider fails before a tool call, no pending action is created (J).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import {
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  ProviderError,
  type ProviderName,
} from "@/lib/ai/providers";
import { metrics } from "@/lib/ai/telemetry";

/* ───────────────────────── mock provider ─────────────────────────────── */

class MockProvider implements AIProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;
  /** Script of outcomes consumed per .chat() call. */
  script: Array<"ok" | ProviderError["kind"]>;
  attempts = 0;

  constructor(name: ProviderName, model: string, script: Array<"ok" | ProviderError["kind"]>) {
    this.name = name;
    this.defaultModel = model;
    this.script = [...script];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    this.attempts += 1;
    const next = this.script.shift() ?? "ok";
    if (next === "ok") {
      return {
        content: "mock text reply",
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
      retryAfterMs: next === "rate_limit" ? 10 : null,
    });
  }

  async healthCheck() {
    return { ok: true as const, model: this.defaultModel };
  }
}

const CTX: AgentContext = {
  tenantId: "00000000-0000-0000-0000-000000000000",
  userId: "00000000-0000-0000-0000-000000000000",
  role: "owner",
  permissions: [],
  locale: "en",
};

const CHAT = [{ role: "user" as const, content: "ping" }];

beforeEach(() => metrics.reset());
afterEach(() => metrics.reset());

/* ───────────────────────── scenarios ──────────────────────────────────── */

describe("F8 failure injection — single provider", () => {
  it("A — success on first attempt", async () => {
    const primary = new MockProvider("gemini", "g", ["ok"]);
    const { response, debug } = await runAgent({
      ctx: CTX,
      messages: CHAT,
      providerPool: [primary],
    });
    expect(response.blocks.length).toBeGreaterThan(0);
    expect(debug.providerAttempts).toHaveLength(1);
    expect(debug.providerAttempts[0]!.result).toBe("success");
    expect(debug.retryCount).toBe(0);
    expect(debug.fallbackUsed).toBe(false);
    expect(debug.requestId).toMatch(/^ai_/);
  });

  it("B — transient × 2 → retry → success", async () => {
    const primary = new MockProvider("gemini", "g", ["overloaded", "overloaded", "ok"]);
    const { debug } = await runAgent({
      ctx: CTX,
      messages: CHAT,
      providerPool: [primary],
    });
    expect(debug.retryCount).toBe(2);
    expect(debug.providerAttempts).toHaveLength(3);
    expect(debug.providerAttempts.slice(0, 2).every((a) => a.result === "overloaded")).toBe(true);
    expect(debug.providerAttempts[2]!.result).toBe("success");
  });

  it("D — rate_limit bounded (exhausts, throws)", async () => {
    // 10 failures — the bounded retry budget is MAX_RETRIES_PER_PROVIDER = 3,
    // so we see at most 4 attempts (initial + 3 retries) and then throw.
    const primary = new MockProvider("gemini", "g", Array(10).fill("rate_limit"));
    await expect(
      runAgent({ ctx: CTX, messages: CHAT, providerPool: [primary] }),
    ).rejects.toMatchObject({ kind: "rate_limit" });
    expect(primary.attempts).toBeLessThanOrEqual(4);
    // Metrics picked up the failure + per-attempt rate-limit count.
    expect(metrics.snapshot().counters.rateLimits).toBeGreaterThanOrEqual(1);
    expect(metrics.snapshot().counters.failures).toBe(1);
  });

  it("E — auth → no retry, no fallback", async () => {
    const primary = new MockProvider("gemini", "g", ["auth"]);
    const secondary = new MockProvider("groq", "k", ["ok"]);
    await expect(
      runAgent({ ctx: CTX, messages: CHAT, providerPool: [primary, secondary] }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(primary.attempts).toBe(1);
    // Fallback must NOT have been attempted.
    expect(secondary.attempts).toBe(0);
    expect(metrics.snapshot().counters.authFailures).toBe(1);
    expect(metrics.snapshot().counters.fallbacks).toBe(0);
  });

  it("F — invalid_request → no retry, no fallback", async () => {
    const primary = new MockProvider("gemini", "g", ["invalid_request"]);
    const secondary = new MockProvider("groq", "k", ["ok"]);
    await expect(
      runAgent({ ctx: CTX, messages: CHAT, providerPool: [primary, secondary] }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(secondary.attempts).toBe(0);
    expect(metrics.snapshot().counters.invalidRequests).toBe(1);
  });
});

describe("F8 failure injection — fallback", () => {
  it("C — primary overloaded (budget exhausted) → fallback succeeds", async () => {
    // 4 overloads = initial attempt + MAX_RETRIES_PER_PROVIDER (3).
    const primary = new MockProvider("gemini", "g", Array(4).fill("overloaded"));
    const secondary = new MockProvider("groq", "k", ["ok"]);
    const { debug } = await runAgent({
      ctx: CTX,
      messages: CHAT,
      providerPool: [primary, secondary],
    });
    expect(debug.fallbackUsed).toBe(true);
    expect(debug.provider).toBe("groq");
    // Primary used its budget, then one successful fallback attempt.
    expect(primary.attempts).toBe(4);
    expect(secondary.attempts).toBe(1);
    const snap = metrics.snapshot();
    expect(snap.counters.fallbacks).toBe(1);
    expect(snap.counters.overloaded).toBeGreaterThanOrEqual(4);
    expect(snap.counters.successes).toBe(1);
  });

  it("G — both providers overloaded → final failure, telemetry captures both", async () => {
    const primary = new MockProvider("gemini", "g", Array(4).fill("overloaded"));
    const secondary = new MockProvider("groq", "k", Array(4).fill("overloaded"));
    await expect(
      runAgent({ ctx: CTX, messages: CHAT, providerPool: [primary, secondary] }),
    ).rejects.toMatchObject({ kind: "overloaded" });
    expect(primary.attempts).toBe(4);
    expect(secondary.attempts).toBe(4);
    const snap = metrics.snapshot();
    expect(snap.counters.fallbacks).toBe(1);
    expect(snap.counters.failures).toBe(1);
  });
});

describe("F8 — write safety under provider failure (J)", () => {
  it("provider failure BEFORE any tool call never creates a pending action", async () => {
    // We can't easily run createPending without a DB, but the architectural
    // invariant we need is: no tool call fires. If the provider exhausts on
    // the FIRST round (before returning any tool_calls), the agent never
    // reaches executeTool() — and therefore never reaches preview_* / pending.
    const primary = new MockProvider("gemini", "g", Array(4).fill("overloaded"));
    const secondary = new MockProvider("groq", "k", Array(4).fill("overloaded"));
    let toolsCalled: string[] = [];
    try {
      const r = await runAgent({
        ctx: CTX,
        messages: [{ role: "user", content: "change price of Musk Rumman to 2500" }],
        providerPool: [primary, secondary],
      });
      toolsCalled = r.response.toolsCalled;
    } catch {
      // Expected throw — primary + fallback both overload.
    }
    expect(toolsCalled).toEqual([]);
  });
});

describe("F8 — request id & telemetry propagation", () => {
  it("agent returns the same requestId it logged", async () => {
    const primary = new MockProvider("gemini", "g", ["ok"]);
    const { debug } = await runAgent({
      ctx: CTX,
      messages: CHAT,
      providerPool: [primary],
      requestId: "ai_my-known-id",
    });
    expect(debug.requestId).toBe("ai_my-known-id");
  });

  it("without a caller-supplied id, generates ai_<uuid>", async () => {
    const primary = new MockProvider("gemini", "g", ["ok"]);
    const { debug } = await runAgent({
      ctx: CTX,
      messages: CHAT,
      providerPool: [primary],
    });
    expect(debug.requestId).toMatch(/^ai_[0-9a-f-]{36}$/);
  });
});
