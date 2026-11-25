import {
  type Content,
  type FunctionDeclaration,
  type FunctionCall as GeminiFunctionCall,
  GoogleGenAI,
  type Part,
} from "@google/genai";

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
 * Google Gemini provider — uses the official @google/genai SDK.
 *
 * Why this is the primary provider (F-plan §1): paid tier gives us enough TPM
 * headroom for real usage, and Gemini's function-calling rarely produces the
 * malformed tool arguments / chat-template token glue we had to salvage around
 * on gpt-oss. The AgentRunner still owns the tool-loop and block composition
 * (provider-agnostic); this class is strictly a translation layer.
 *
 * Supports compositional + parallel function calls per the F-plan §30.
 */

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;
  readonly defaultModel: string;
  private readonly client: GoogleGenAI;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.defaultModel =
      opts.model ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;
    const contents = toGeminiContents(req.messages);
    const functionDeclarations = toGeminiFunctionDeclarations(req.tools);

    const timer = new AbortController();
    const timeoutHandle = setTimeout(() => timer.abort(), req.timeoutMs ?? 30_000);

    try {
      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: req.system,
          tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
          temperature: req.temperature ?? 0.2,
          maxOutputTokens: req.maxTokens ?? 3000,
          // Signal propagates through the SDK's fetch under the hood.
          abortSignal: timer.signal,
        } as Record<string, unknown>,
      });

      const toolCalls = extractToolCalls(response.functionCalls);
      const content = (response.text ?? "").trim();
      const usage = response.usageMetadata;

      return {
        content,
        toolCalls,
        usage: {
          promptTokens: usage?.promptTokenCount ?? 0,
          completionTokens: usage?.candidatesTokenCount ?? 0,
          totalTokens: usage?.totalTokenCount ?? 0,
          cachedTokens: usage?.cachedContentTokenCount ?? undefined,
        },
        finishReason: response.candidates?.[0]?.finishReason ?? undefined,
        provider: "gemini",
        model,
      };
    } catch (e) {
      throw classifyGeminiError(e);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async healthCheck(): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
    try {
      // 1-token probe — tiny, enough to validate key + model name.
      const r = await this.client.models.generateContent({
        model: this.defaultModel,
        contents: [{ role: "user", parts: [{ text: "ok" }] }],
        config: { maxOutputTokens: 1 } as Record<string, unknown>,
      });
      if (r) return { ok: true, model: this.defaultModel };
      return { ok: false, reason: "no response" };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "unknown" };
    }
  }
}

/* ────────────────────────────────────────────── conversion helpers ──────── */

function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      // Gemini takes system as a top-level config field. Any system turn after
      // the first (nudges, locale re-asserts) is folded into a user message so
      // the model still sees the instruction.
      out.push({ role: "user", parts: [{ text: `(system) ${m.content}` }] });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === "assistant") {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.argsJson) as Record<string, unknown>;
          } catch {
            // Malformed — pass as string so Gemini still sees intent.
            args = { _raw: tc.argsJson };
          }
          parts.push({ functionCall: { name: tc.name, args, id: tc.id } });
        }
      }
      if (parts.length === 0) parts.push({ text: "" });
      out.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      // Gemini expects tool results on a `user` role with a functionResponse
      // part. The `name` must match the original FunctionCall.name.
      let response: Record<string, unknown>;
      try {
        const parsed = JSON.parse(m.content) as unknown;
        response = typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { output: parsed };
      } catch {
        response = { output: m.content };
      }
      out.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? "unknown_tool",
              response,
              ...(m.toolCallId ? { id: m.toolCallId } : {}),
            },
          },
        ],
      });
    }
  }
  return out;
}

function toGeminiFunctionDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    // Gemini's `parametersJsonSchema` accepts full JSON Schema — our existing
    // tool schemas work verbatim with no translation. `parameters` is the
    // Protobuf-flavoured field; we deliberately use `parametersJsonSchema`.
    parametersJsonSchema: t.function.parameters,
  }));
}

function extractToolCalls(calls: GeminiFunctionCall[] | undefined): ProviderToolCall[] {
  if (!calls || calls.length === 0) return [];
  return calls.map((c, i) => ({
    id: c.id ?? `gemini_${Date.now()}_${i}`,
    name: c.name ?? "unknown",
    argsJson: JSON.stringify(c.args ?? {}),
  }));
}

function classifyGeminiError(e: unknown): ProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  // AbortSignal fired → treat as our own timeout.
  if (e instanceof Error && (e.name === "AbortError" || lower.includes("aborted"))) {
    return new ProviderError({ kind: "timeout", provider: "gemini", message: msg, raw: e });
  }
  // The @google/genai SDK wraps HTTP errors into messages that include the
  // status code when available.
  const statusMatch = /\b(4\d\d|5\d\d)\b/.exec(msg);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 429 || lower.includes("resource_exhausted") || lower.includes("rate_limit")) {
    return new ProviderError({ kind: "rate_limit", provider: "gemini", message: msg, raw: e });
  }
  if (status === 503 || lower.includes("unavailable") || lower.includes("overload")) {
    return new ProviderError({ kind: "overloaded", provider: "gemini", message: msg, raw: e });
  }
  if (status === 401 || status === 403 || lower.includes("unauthenticated") || lower.includes("permission_denied")) {
    return new ProviderError({ kind: "auth", provider: "gemini", message: msg, raw: e });
  }
  if (status === 400 || lower.includes("invalid_argument")) {
    return new ProviderError({ kind: "invalid_request", provider: "gemini", message: msg, raw: e });
  }
  if (status != null && status >= 500) {
    return new ProviderError({ kind: "server", provider: "gemini", message: msg, raw: e });
  }
  return new ProviderError({ kind: "unknown", provider: "gemini", message: msg, raw: e });
}
