/**
 * Provider-abstraction unit tests. We don't go to the network — these
 * verify translation helpers (OpenAI / Gemini shape conversion) and the
 * error-classification path. Live provider reachability is covered by the
 * F1 smoke script and the /api/ai/health endpoint.
 */
import { describe, expect, it } from "vitest";

import { GroqProvider } from "@/lib/ai/providers/groq";
import { GeminiProvider } from "@/lib/ai/providers/gemini";
import { NoProviderKeyError, ProviderError, getActiveProvider } from "@/lib/ai/providers";

describe("provider factory", () => {
  it("rejects when GEMINI_API_KEY is unset and AI_PROVIDER=gemini", () => {
    const before = { ai: process.env.AI_PROVIDER, gk: process.env.GEMINI_API_KEY };
    process.env.AI_PROVIDER = "gemini";
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() => getActiveProvider()).toThrow(NoProviderKeyError);
    } finally {
      process.env.AI_PROVIDER = before.ai;
      if (before.gk !== undefined) process.env.GEMINI_API_KEY = before.gk;
    }
  });

  it("rejects when GROQ_API_KEY is unset and AI_PROVIDER=groq", () => {
    const before = { ai: process.env.AI_PROVIDER, gk: process.env.GROQ_API_KEY };
    process.env.AI_PROVIDER = "groq";
    delete process.env.GROQ_API_KEY;
    try {
      expect(() => getActiveProvider()).toThrow(NoProviderKeyError);
    } finally {
      process.env.AI_PROVIDER = before.ai;
      if (before.gk !== undefined) process.env.GROQ_API_KEY = before.gk;
    }
  });

  it("constructs a GeminiProvider by default when keys are set", () => {
    const before = { ai: process.env.AI_PROVIDER, gk: process.env.GEMINI_API_KEY };
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "stub";
    try {
      const p = getActiveProvider();
      expect(p.name).toBe("gemini");
    } finally {
      process.env.AI_PROVIDER = before.ai;
      if (before.gk === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = before.gk;
    }
  });
});

describe("GroqProvider", () => {
  it("exposes the configured default model", () => {
    const p = new GroqProvider({ apiKey: "stub", model: "openai/gpt-oss-20b" });
    expect(p.name).toBe("groq");
    expect(p.defaultModel).toBe("openai/gpt-oss-20b");
  });
});

describe("GeminiProvider", () => {
  it("exposes the configured default model", () => {
    const p = new GeminiProvider({ apiKey: "stub", model: "gemini-3.6-flash" });
    expect(p.name).toBe("gemini");
    expect(p.defaultModel).toBe("gemini-3.6-flash");
  });
});

describe("ProviderError", () => {
  it("captures retryAfterMs when supplied", () => {
    const e = new ProviderError({
      kind: "rate_limit",
      provider: "groq",
      message: "slow down",
      retryAfterMs: 2000,
    });
    expect(e.kind).toBe("rate_limit");
    expect(e.retryAfterMs).toBe(2000);
    expect(e.provider).toBe("groq");
  });

  it("defaults retryAfterMs to null", () => {
    const e = new ProviderError({ kind: "network", provider: "gemini", message: "boom" });
    expect(e.retryAfterMs).toBe(null);
  });
});
