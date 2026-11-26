/**
 * Loop-exit guard — ONE assistant turn regardless of model exuberance.
 *
 * Real-world trace (user's iPhone, "هاااي"):
 *   roundsUsed: 5, durationMs: 19,540
 *   model called render_text in round 1, then re-called render_text in
 *   rounds 2-5 echoing the re-asserted locale directive ("Understood.
 *   All responses will be provided in Arabic…").
 *
 * Fix: once a round's tool calls are ENTIRELY render_* / preview_* AND
 * renderedBlocks has at least one entry, the agent breaks the loop and
 * ships the buffered answer. No more "Understood" rounds.
 *
 * This test uses a provider mock to reproduce the worst case and assert
 * the invariant end-to-end.
 */
import { describe, expect, it } from "vitest";

import type { AgentContext } from "@/lib/ai/context";
import { runAgent } from "@/lib/ai/agent";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
} from "@/lib/ai/providers";

const CTX: AgentContext = {
  tenantId: "00000000-0000-0000-0000-000000000000",
  userId: "00000000-0000-0000-0000-000000000000",
  role: "owner",
  permissions: [],
  locale: "en",
};

/** Build a provider that keeps calling render_text every round. */
function chattyRenderTextProvider(): AIProvider {
  let roundNum = 0;
  return {
    name: "gemini",
    defaultModel: "gemini-mock",
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      roundNum += 1;
      // Each round calls render_text with a different short string.
      return {
        content: "",
        toolCalls: [
          {
            id: `tc-${roundNum}`,
            name: "render_text",
            argsJson: JSON.stringify({
              text: `Understood. Round ${roundNum} greeting.`,
            }),
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        provider: "gemini",
        model: "gemini-mock",
      };
    },
    async healthCheck() {
      return { ok: true, model: "gemini-mock" };
    },
  };
}

describe("agent loop-exit guard", () => {
  it("stops looping after one render-only round even if model wants more", async () => {
    const provider = chattyRenderTextProvider();
    const { response, debug } = await runAgent({
      ctx: CTX,
      // Non-trivial input so the fast-path doesn't short-circuit — we want
      // to actually exercise the loop guard.
      messages: [{ role: "user", content: "give me a summary" }],
      provider,
    });
    // Invariant: one logical turn → at most one text block after collapse.
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]!.kind).toBe("text");
    // Invariant: the loop exited after round 1 (pre-fix this would have
    // burned 5 rounds).
    expect(debug.roundsUsed).toBeLessThanOrEqual(2);
  });

  it("keeps running when model mixes data + render tools (loop must continue)", async () => {
    // Provider that calls search_products in round 1 (NOT a render tool),
    // then render_product_card in round 2. The guard must NOT exit after
    // round 1 because no render blocks are buffered yet.
    let r = 0;
    const provider: AIProvider = {
      name: "gemini",
      defaultModel: "gemini-mock",
      async chat() {
        r += 1;
        if (r === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "tc-s",
                name: "render_text",
                argsJson: JSON.stringify({ text: "Here you go." }),
              },
            ],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            provider: "gemini",
            model: "gemini-mock",
          };
        }
        // Round 2+: model would normally continue, but the guard exits.
        return {
          content: "",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          provider: "gemini",
          model: "gemini-mock",
        };
      },
      async healthCheck() {
        return { ok: true, model: "gemini-mock" };
      },
    };
    const { response, debug } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "give me info" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]!.kind).toBe("text");
    expect(debug.roundsUsed).toBeLessThanOrEqual(2);
  });
});
