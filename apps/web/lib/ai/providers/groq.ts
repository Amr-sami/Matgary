import type { ToolDefinition } from "../tools/types";

import type {
  AIProvider,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderToolCall,
} from "./types";
import { ProviderError } from "./types";

/**
 * Groq provider — raw fetch against the OpenAI-compatible endpoint. Kept as
 * fallback for Gemini (per the F-wave plan). The tool-call-loop fixes we
 * added during W3 (salvage, nudge, nullable schemas, retry hints) live in
 * the agent, NOT here, so switching provider doesn't lose them.
 */

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

interface OaToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OaToolCallMessage[];
  tool_call_id?: string;
}
interface OaChoice {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OaToolCallMessage[];
  };
  finish_reason?: string;
}
interface OaResponse {
  choices?: OaChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class GroqProvider implements AIProvider {
  readonly name = "groq" as const;
  readonly defaultModel: string;
  private readonly apiKey: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;
    const payload = {
      model,
      messages: toOpenAiMessages(req.system, req.messages),
      tools: toOpenAiTools(req.tools),
      tool_choice: "auto" as const,
      max_tokens: req.maxTokens ?? 3000,
      temperature: req.temperature ?? 0.2,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    };

    const res = await postWithTimeout(GROQ_ENDPOINT, payload, this.apiKey, req.timeoutMs ?? 30_000);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyGroqError(res.status, body);
    }
    const data = (await res.json()) as OaResponse;
    const msg = data.choices?.[0]?.message;
    if (!msg) {
      throw new ProviderError({
        kind: "server",
        provider: "groq",
        message: "Empty choices from Groq",
      });
    }
    return {
      content: msg.content ?? "",
      toolCalls:
        msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          argsJson: tc.function.arguments,
        })) ?? [],
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: data.choices?.[0]?.finish_reason,
      provider: "groq",
      model,
    };
  }

  async healthCheck(): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      if (res.ok) return { ok: true, model: this.defaultModel };
      return { ok: false, reason: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "network" };
    }
  }
}

function toOpenAiMessages(system: string, messages: ChatMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.toolCalls.map((tc): OaToolCallMessage => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argsJson },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

async function postWithTimeout(
  url: string,
  payload: unknown,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderError({ kind: "timeout", provider: "groq", message: "Groq request timed out" });
    }
    throw new ProviderError({
      kind: "network",
      provider: "groq",
      message: e instanceof Error ? e.message : "network error",
      raw: e,
    });
  } finally {
    clearTimeout(timer);
  }
}

function classifyGroqError(status: number, body: string): ProviderError {
  // "Please try again in Xs" hint — same format for 429 and 503.
  const hintMs = parseRetryHintMs(body);
  if (status === 429) {
    return new ProviderError({
      kind: "rate_limit",
      provider: "groq",
      message: `Groq rate limit: ${body.slice(0, 200)}`,
      retryAfterMs: hintMs,
      raw: body,
    });
  }
  if (status === 503) {
    return new ProviderError({
      kind: "overloaded",
      provider: "groq",
      message: "Groq overloaded",
      retryAfterMs: hintMs,
      raw: body,
    });
  }
  if (status === 400 && /tool_use_failed|tool_call_validation|Failed to parse tool call/i.test(body)) {
    return new ProviderError({
      kind: "tool_use_failed",
      provider: "groq",
      message: `Groq tool_use_failed: ${body.slice(0, 200)}`,
      raw: body,
    });
  }
  if (status === 400) {
    return new ProviderError({
      kind: "invalid_request",
      provider: "groq",
      message: `Groq 400: ${body.slice(0, 200)}`,
      raw: body,
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError({
      kind: "auth",
      provider: "groq",
      message: `Groq auth error ${status}`,
      raw: body,
    });
  }
  return new ProviderError({
    kind: status >= 500 ? "server" : "unknown",
    provider: "groq",
    message: `Groq ${status}: ${body.slice(0, 200)}`,
    raw: body,
  });
}

function parseRetryHintMs(body: string): number | null {
  const m = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)/i.exec(body);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const buffer = 300;
  return (m[2]?.toLowerCase() === "ms" ? n : n * 1000) + buffer;
}
