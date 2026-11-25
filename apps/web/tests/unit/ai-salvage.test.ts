/**
 * `salvageLeakedRenderCalls` tests — the agent's safety net for turns that
 * emit render_* tool calls as plain content instead of using the tool_calls
 * channel.
 *
 * Exercises the salvager end-to-end via runAgent, injecting a MockProvider so
 * we don't hit any network. Provider-agnostic: works for the Groq and Gemini
 * variants because both land in the same `ChatResponse` shape at the agent
 * boundary.
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

/** Mock provider that always returns the given content with no tool calls.
 *  The agent treats "no tool_calls" as a final answer and runs the salvage
 *  path on the content when it mentions `render_*`. */
function mockProvider(content: string): AIProvider {
  return {
    name: "gemini",
    defaultModel: "gemini-mock",
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return {
        content,
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        provider: "gemini",
        model: "gemini-mock",
      };
    },
    async healthCheck() {
      return { ok: true, model: "gemini-mock" };
    },
  };
}

describe("salvageLeakedRenderCalls — via runAgent (provider mock)", () => {
  it("salvages a single render_text leaked as content", async () => {
    const provider = mockProvider(
      JSON.stringify({ type: "render_text", text: "Hello from salvage." }),
    );
    const { response } = await runAgent({
      ctx: CTX,
      // NOT "hi" — the trivial-greeting fast path would short-circuit the
      // agent before the mock provider's leaked-render content is produced.
      messages: [{ role: "user", content: "run x" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]).toEqual({ kind: "text", text: "Hello from salvage." });
  });

  it("salvages a render_chart leaked as content with real chart data", async () => {
    const leaked = JSON.stringify({
      name: "render_chart",
      arguments: {
        chart_type: "line",
        title: "Monthly Revenue",
        series: [{ data_key: "revenue", label: "Revenue" }],
        data: [
          { month: "Oct", revenue: 1000 },
          { month: "Nov", revenue: 2000 },
        ],
        x_key: "month",
        currency: "EGP",
      },
    });
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "chart please" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    const block = response.blocks[0]!;
    expect(block.kind).toBe("chart");
    if (block.kind !== "chart") throw new Error("not chart");
    expect(block.title).toBe("Monthly Revenue");
    expect(block.chartType).toBe("line");
    expect(block.data).toHaveLength(2);
    expect(block.series[0]?.dataKey).toBe("revenue");
  });

  it("salvages render_table with full rows + columns", async () => {
    const leaked = JSON.stringify({
      type: "render_table",
      title: "Top customers",
      columns: [
        { key: "name", label: "Name" },
        { key: "spend", label: "Spend", align: "end", format: "money" },
      ],
      rows: [
        { name: "Amr", spend: 5000 },
        { name: "Sara", spend: 4000 },
      ],
      currency: "EGP",
    });
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "table" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    const block = response.blocks[0]!;
    expect(block.kind).toBe("table");
    if (block.kind !== "table") throw new Error("not table");
    expect(block.title).toBe("Top customers");
    expect(block.rows).toHaveLength(2);
    expect(block.columns[1]?.format).toBe("money");
  });

  it("salvages render_kpi with trend_pct present", async () => {
    const leaked = JSON.stringify({
      name: "render_kpi",
      arguments: {
        title: "Headline",
        items: [
          { label: "Revenue", value: "5000 EGP", trend_pct: 10, tone: "up" },
          { label: "Sales", value: "12" },
        ],
      },
    });
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "kpi" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    const block = response.blocks[0]!;
    expect(block.kind).toBe("kpi");
    if (block.kind !== "kpi") throw new Error("not kpi");
    expect(block.items).toHaveLength(2);
    expect(block.items[0]?.trendPct).toBe(10);
  });

  it("salvages a sequence of render_* calls in one content blob", async () => {
    const leaked =
      JSON.stringify({ type: "render_text", text: "Here you go:" }) +
      "\n" +
      JSON.stringify({
        type: "render_chart",
        chart_type: "bar",
        title: "By Brand",
        series: [{ data_key: "rev", label: "Rev" }],
        data: [{ brand: "A", rev: 1 }, { brand: "B", rev: 2 }],
        x_key: "brand",
      }) +
      "\n" +
      JSON.stringify({
        type: "render_kpi",
        items: [{ label: "Total", value: "3" }],
      });
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "give me a mix" }],
      provider,
    });
    expect(response.blocks.map((b) => b.kind)).toEqual(["text", "chart", "kpi"]);
  });

  it("strips chat-template tokens glued onto the tool name", async () => {
    const leaked = JSON.stringify({
      type: "render_text<|channel|>commentary",
      text: "Observed glue",
    });
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "x" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]).toEqual({ kind: "text", text: "Observed glue" });
  });

  it("passes legitimate prose through untouched (no salvage)", async () => {
    const provider = mockProvider(
      "Here is a short summary of your data without any tool-call JSON.",
    );
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "how am I doing" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]).toMatchObject({
      kind: "text",
      text: "Here is a short summary of your data without any tool-call JSON.",
    });
  });

  it("falls back gracefully for truly empty content", async () => {
    const provider = mockProvider("");
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "x" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]?.kind).toBe("text");
  });

  it("salvages JSON even when prefixed by commentary text", async () => {
    const leaked =
      "Here's your chart:\n" +
      JSON.stringify({
        type: "render_chart",
        chart_type: "line",
        title: "Weekly Revenue",
        series: [{ data_key: "rev", label: "Revenue" }],
        data: [{ day: "Mon", rev: 100 }, { day: "Tue", rev: 150 }],
        x_key: "day",
      });
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "chart" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]?.kind).toBe("chart");
  });

  it("salvages JSON wrapped in markdown code fences", async () => {
    const leaked =
      "```json\n" +
      JSON.stringify({
        name: "render_text",
        arguments: { text: "Fenced reply" },
      }) +
      "\n```";
    const provider = mockProvider(leaked);
    const { response } = await runAgent({
      ctx: CTX,
      messages: [{ role: "user", content: "x" }],
      provider,
    });
    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]).toEqual({ kind: "text", text: "Fenced reply" });
  });
});
