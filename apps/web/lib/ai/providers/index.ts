import { GeminiProvider } from "./gemini";
import { GroqProvider } from "./groq";
import type { AIProvider, ProviderName } from "./types";

export type { AIProvider, ChatMessage, ChatRequest, ChatResponse, ProviderName, ProviderToolCall, ProviderUsage } from "./types";
export { ProviderError } from "./types";

/**
 * Pick the active provider based on env.
 *
 *   AI_PROVIDER=gemini  (default)  → Gemini, requires GEMINI_API_KEY
 *   AI_PROVIDER=groq               → Groq,   requires GROQ_API_KEY
 *
 * The agent calls `getActiveProvider()` once per request. Fallback is wired
 * through `getFallbackProvider()` + the F8 reliability layer.
 */
export function getActiveProvider(): AIProvider {
  const name: ProviderName = (process.env.AI_PROVIDER === "groq" ? "groq" : "gemini");
  if (name === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new NoProviderKeyError("gemini", "GEMINI_API_KEY");
    return new GeminiProvider({ apiKey: key });
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new NoProviderKeyError("groq", "GROQ_API_KEY");
  return new GroqProvider({ apiKey: key });
}

/**
 * F8 — Return the opposite-provider instance if its key is configured.
 * Used by the reliability layer to fall back off a rate-limited / overloaded
 * primary. Returns null when no fallback is available — the orchestrator
 * then runs in single-provider mode (still bounded-retrying the primary).
 *
 * Safe to call before the primary is known; this function ONLY builds an
 * instance, it never calls the provider.
 */
export function getFallbackProvider(primary: ProviderName): AIProvider | null {
  if (primary === "gemini") {
    const key = process.env.GROQ_API_KEY;
    if (!key) return null;
    return new GroqProvider({ apiKey: key });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GeminiProvider({ apiKey: key });
}

/** Raised when the configured provider has no key. Route catches it and
 *  returns `AI_DISABLED` so the mobile UI can show a configuration message. */
export class NoProviderKeyError extends Error {
  readonly provider: ProviderName;
  readonly envVar: string;
  constructor(provider: ProviderName, envVar: string) {
    super(`${envVar} is not set; the ${provider} provider cannot run.`);
    this.name = "NoProviderKeyError";
    this.provider = provider;
    this.envVar = envVar;
  }
}
