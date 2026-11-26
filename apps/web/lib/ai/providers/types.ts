import type { ToolDefinition } from "../tools/types";

/**
 * Neutral provider contract.
 *
 * The AgentRunner knows nothing about Gemini, Groq or any specific SDK. It
 * assembles a conversation in THIS shape, hands it to `provider.chat(...)`,
 * then interprets the returned `toolCalls`/`content` against the tool registry.
 *
 * Two shapes are deliberately provider-neutral:
 *   • ToolDefinition — already JSON-Schema-based, maps cleanly to both the
 *     OpenAI chat/completions `tools` array and Gemini's `functionDeclarations`.
 *   • ChatMessage — aligned with OpenAI's role model (system/user/assistant/
 *     tool); Gemini providers translate tool/system/role conventions internally.
 */

export type ProviderName = "gemini" | "groq";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ProviderToolCall {
  /** Stable id the provider assigned; echoed back in the tool-response message
   *  so the model can match tool outputs to its calls. Gemini may omit this
   *  when only one call is in flight; the provider fills a fallback. */
  id: string;
  name: string;
  /** Raw JSON string. The agent passes this verbatim to executeTool() which
   *  owns schema validation + sandboxed parsing. */
  argsJson: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on `assistant` messages that invoked tools. */
  toolCalls?: ProviderToolCall[];
  /** Present on `tool` messages — ties the tool output back to the call id. */
  toolCallId?: string;
  /** Present on `tool` messages — the function name that produced this output.
   *  OpenAI ignores it; Gemini requires it. */
  toolName?: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Override the provider's default model for this one call. */
  model?: string;
  maxTokens?: number;
  /** 0–2 (OpenAI) / 0–2 (Gemini). Providers clamp as needed. */
  temperature?: number;
  /** gpt-oss "low"/"medium"/"high"; Gemini ignores (no equivalent knob yet). */
  reasoningEffort?: "low" | "medium" | "high";
  /** Hard ceiling on a single provider call (ms). The provider enforces it. */
  timeoutMs?: number;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported cached input tokens, when available (Gemini). */
  cachedTokens?: number;
}

export interface ChatResponse {
  /** The model's free-text reply (may be empty when toolCalls are present). */
  content: string;
  toolCalls: ProviderToolCall[];
  usage: ProviderUsage;
  /** Provider-specific finish reason. Diagnostic only; don't branch on it. */
  finishReason?: string;
  /** Normalised provider id (for logging / audit). */
  provider: ProviderName;
  /** Exact model id used for this call (post-override). */
  model: string;
}

/**
 * Classification the agent uses to pick retry / fallback behaviour. Providers
 * translate their native error shapes into this closed set.
 */
export type ErrorKind =
  | "rate_limit"      // 429 / token-per-minute cap
  | "overloaded"      // 503 / provider-side overload
  | "timeout"
  | "tool_use_failed" // model-output invalid tool_call (Groq's 400; Gemini malformed args)
  | "invalid_request" // our payload is wrong; no retry
  | "auth"            // bad key / no quota
  | "network"
  | "server"          // 5xx not classified above
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly provider: ProviderName;
  /** Milliseconds the provider suggests waiting (parsed from "try again in Xs"). */
  readonly retryAfterMs: number | null;
  readonly raw: unknown;

  constructor(opts: {
    kind: ErrorKind;
    provider: ProviderName;
    message: string;
    retryAfterMs?: number | null;
    raw?: unknown;
  }) {
    super(opts.message);
    this.name = "ProviderError";
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.raw = opts.raw;
  }
}

export interface AIProvider {
  readonly name: ProviderName;
  /** Default model if a caller doesn't override. */
  readonly defaultModel: string;
  /** Single non-streaming turn. Returns the model's next move (tool_calls or final text). */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Cheap liveness check — does NOT burn generation tokens. */
  healthCheck(): Promise<{ ok: true; model: string } | { ok: false; reason: string }>;
}
