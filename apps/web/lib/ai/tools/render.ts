import { looksLikeStructuredLeak } from "../blocks/sanitise";
import {
  buildInventorySummary,
  buildProductComparison,
  buildSalesSummary,
  type ComparisonProductInput,
} from "../blocks/summaries";
import type {
  AiBlock,
  ClarificationBlock,
  ClarificationOption,
  WarningBlock,
} from "../responses";

import { parsePeriod } from "./_shared";
import type { Tool } from "./types";

/**
 * Meta-tools the model uses to COMPOSE its final answer.
 *
 * The model doesn't write a plain-text reply at the end — it calls one or
 * more `render_*` tools. The orchestrator intercepts the call, builds the
 * corresponding `AiBlock`, and buffers it. When the model's next turn comes
 * back with no further tool_calls, the buffered blocks become the response.
 *
 * This is more reliable than `response_format: json_schema` on open-weights
 * models like gpt-oss, and lets a single reply mix text + chart + table.
 */

/** Discriminator so the executor can tell the meta-tools apart. */
export const RENDER_TOOL_PREFIX = "render_";

/* --------------------------------------------------------------- renderers */

export const renderText: Tool = {
  name: "render_text",
  description:
    "Append a plain-text paragraph to the final reply. Use for the main explanation. Keep it concise; the user also sees any charts/tables/KPIs you render.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, description: "The paragraph text, in the LOCKED user language." },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) return { ok: false, error: "EMPTY_TEXT" };
    // Reject text that is in fact a structured block / tool-call JSON that
    // the model stringified. The agent will nudge the model to re-render
    // through the right channel (tool call). This prevents the "raw JSON in
    // a chat bubble" class of bug entirely.
    if (looksLikeStructuredLeak(text)) {
      console.warn("[ai/render_text] structured JSON leak rejected", {
        preview: text.slice(0, 160),
      });
      return { ok: false, error: "STRUCTURED_LEAK_REJECTED" };
    }
    const block: AiBlock = { kind: "text", text };
    return { ok: true, blocks: [block] };
  },
};

export const renderChart: Tool = {
  name: "render_chart",
  description:
    "Append a chart to the final reply. Pick chart_type that best fits the data: line/area for trends over time; bar for comparisons across categories; pie/donut for shares of a whole. Pass data as an array of row objects. x_key names the field each row keys by (required for line/bar/area). Each series.data_key must exist as a numeric field on every row.",
  parameters: {
    type: "object",
    properties: {
      chart_type: { type: "string", enum: ["line", "bar", "pie", "donut", "area"] },
      title: { type: "string", minLength: 1, description: "Chart title in the LOCKED user language." },
      description: { type: "string", description: "Optional caption below the title, in the LOCKED user language." },
      x_key: { type: "string", description: "Row key used as x-axis label (e.g. 'day', 'brand'). Required for line/bar/area." },
      series: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            data_key: { type: "string" },
            label: { type: "string" },
          },
          required: ["data_key", "label"],
          additionalProperties: false,
        },
      },
      data: {
        type: "array",
        minItems: 1,
        items: { type: "object" },
      },
      currency: { type: "string", description: "Optional ISO currency code (e.g. 'EGP')." },
    },
    required: ["chart_type", "title", "series", "data"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const chartType = args.chart_type as "line" | "bar" | "pie" | "donut" | "area";
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "EMPTY_TITLE" };
    const description = typeof args.description === "string" ? args.description : undefined;
    const xKey = typeof args.x_key === "string" ? args.x_key : undefined;
    const series = Array.isArray(args.series)
      ? (args.series as Array<Record<string, unknown>>).map((s) => ({
          dataKey: String(s.data_key),
          label: String(s.label),
          color: typeof s.color === "string" ? s.color : undefined,
        }))
      : [];
    const data = Array.isArray(args.data)
      ? (args.data as Array<Record<string, unknown>>).map(
          (row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, typeof v === "number" || typeof v === "string" ? v : String(v)]),
            ) as Record<string, string | number>,
        )
      : [];
    if (series.length === 0 || data.length === 0) {
      return { ok: false, error: "EMPTY_CHART" };
    }
    const currency = typeof args.currency === "string" ? args.currency : undefined;
    const block: AiBlock = {
      kind: "chart",
      chartType,
      title,
      ...(description ? { description } : {}),
      ...(xKey ? { xKey } : {}),
      series,
      data,
      ...(currency ? { currency } : {}),
    };
    return { ok: true, blocks: [block] };
  },
};

export const renderTable: Tool = {
  name: "render_table",
  description:
    "Append a data table to the final reply. Use for lists where the user wants to scan rows (top customers, low-stock items, orders). Columns define header labels + alignment + format hints (money/number/text/date/percent). Each row is an object keyed by column.key.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      description: { type: "string" },
      columns: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            align: { type: "string", enum: ["start", "end", "center"] },
            format: { type: "string", enum: ["money", "number", "text", "date", "percent"] },
          },
          required: ["key", "label"],
          additionalProperties: false,
        },
      },
      rows: {
        type: "array",
        items: { type: "object" },
      },
      currency: { type: "string" },
    },
    required: ["title", "columns", "rows"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "EMPTY_TITLE" };
    const description = typeof args.description === "string" ? args.description : undefined;
    const columns = Array.isArray(args.columns)
      ? (args.columns as Array<Record<string, unknown>>).map((c) => {
          const align =
            c.align === "start" || c.align === "end" || c.align === "center"
              ? (c.align as "start" | "end" | "center")
              : undefined;
          const format =
            c.format === "money" ||
            c.format === "number" ||
            c.format === "text" ||
            c.format === "date" ||
            c.format === "percent"
              ? (c.format as "money" | "number" | "text" | "date" | "percent")
              : undefined;
          return {
            key: String(c.key),
            label: String(c.label),
            ...(align ? { align } : {}),
            ...(format ? { format } : {}),
          };
        })
      : [];
    const rows = Array.isArray(args.rows)
      ? (args.rows as Array<Record<string, unknown>>).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [
              k,
              v === null || typeof v === "number" || typeof v === "string" ? v : String(v),
            ]),
          ) as Record<string, string | number | null>,
        )
      : [];
    const currency = typeof args.currency === "string" ? args.currency : undefined;
    const block: AiBlock = {
      kind: "table",
      title,
      ...(description ? { description } : {}),
      columns,
      rows,
      ...(currency ? { currency } : {}),
    };
    return { ok: true, blocks: [block] };
  },
};

export const renderKpi: Tool = {
  name: "render_kpi",
  description:
    "Append a row of KPI cards to the final reply. Use for 2–4 headline numbers (e.g. revenue / profit / margin). trend_pct colours the card up/down.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
            // Nullable — gpt-oss emits `null` for "unknown trend", which
            // Groq's validator rejects when the type is plain "number".
            trend_pct: { type: ["number", "null"] },
            tone: { type: "string", enum: ["up", "down", "neutral"] },
          },
          required: ["label", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const title = typeof args.title === "string" ? args.title : undefined;
    const items = Array.isArray(args.items)
      ? (args.items as Array<Record<string, unknown>>).map((it) => {
          const tone =
            it.tone === "up" || it.tone === "down" || it.tone === "neutral"
              ? (it.tone as "up" | "down" | "neutral")
              : undefined;
          return {
            label: String(it.label),
            value: String(it.value),
            ...(typeof it.trend_pct === "number" ? { trendPct: it.trend_pct } : {}),
            ...(tone ? { tone } : {}),
          };
        })
      : [];
    if (items.length === 0) return { ok: false, error: "EMPTY_KPI" };
    const block: AiBlock = {
      kind: "kpi",
      ...(title ? { title } : {}),
      items,
    };
    return { ok: true, blocks: [block] };
  },
};

/**
 * render_product_card — show a SPECIFIC database product to the user. Every
 * field MUST come verbatim from a prior search_products / get_product result;
 * the agent is explicitly told so in its system prompt (F-plan §15).
 *
 * `product_id` is required — it's the grounding anchor. The downstream
 * validation layer (grounding.ts) checks this id was actually returned by a
 * tool in THIS turn; otherwise the block is dropped.
 */
export const renderProductCard: Tool = {
  name: "render_product_card",
  description:
    "Append a product card to the final reply. Use after search_products or get_product when showing a specific product to the user. Every field must come from a tool result — NEVER invent a product_id, name, price or stock. For 'which one did you mean?', emit one card per candidate in order of best match.",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "uuid returned by search_products / get_product. Grounding anchor." },
      name: { type: "string" },
      brand: { type: ["string", "null"] },
      sku: { type: ["string", "null"] },
      price: { type: "number" },
      currency: { type: "string", description: "ISO code, usually EGP." },
      quantity: { type: "integer", minimum: 0 },
      stock_state: { type: "string", enum: ["in_stock", "low_stock", "out_of_stock"] },
      image_url: { type: ["string", "null"] },
      caption: { type: "string", description: "Optional sub-line, e.g. 'Matched on SKU' or 'أعلى تطابق'." },
    },
    required: ["product_id", "name", "price", "currency", "quantity", "stock_state"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const productId = String(args.product_id ?? "").trim();
    if (!productId) return { ok: false, error: "MISSING_PRODUCT_ID" };
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "MISSING_NAME" };
    const stockRaw = args.stock_state;
    const stockState: "in_stock" | "low_stock" | "out_of_stock" =
      stockRaw === "low_stock" || stockRaw === "out_of_stock" ? stockRaw : "in_stock";
    const block: AiBlock = {
      kind: "product_card",
      productId,
      name,
      brand: typeof args.brand === "string" ? args.brand : null,
      sku: typeof args.sku === "string" ? args.sku : null,
      price: typeof args.price === "number" ? args.price : Number(args.price ?? 0),
      currency: typeof args.currency === "string" ? args.currency : "EGP",
      quantity: typeof args.quantity === "number" ? args.quantity : Number(args.quantity ?? 0),
      stockState,
      imageUrl: typeof args.image_url === "string" ? args.image_url : null,
      caption: typeof args.caption === "string" ? args.caption : undefined,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ────────────────────── F4 — new structured blocks ────────────────────── */

/**
 * render_clarification — ask "which one did you mean?" with tappable options.
 *
 * Each option carries a REAL entity uuid from a prior tool call + the exact
 * follow-up text the mobile app will send back as a new user turn when tapped
 * (so F6 context + F5 preview continue unchanged). Options whose entity_id
 * wasn't returned this turn are dropped by `enforceGrounding`.
 */
export const renderClarification: Tool = {
  name: "render_clarification",
  description:
    "Ask the user to choose between 2-6 grounded options. Use when a request is ambiguous ('change its price' + multiple candidates) or when the user asks you to compare without naming the targets. Each option.entity_id MUST be a uuid returned by search_products / get_product / another data tool this turn. follow_up_text is sent back as a NEW user turn when tapped — write it as if the user is speaking (e.g. 'change Pink Diva price to 2500').",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      prompt: { type: "string" },
      entity_type: {
        type: "string",
        enum: ["product", "customer", "employee", "generic"],
      },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            entity_id: { type: "string", description: "uuid returned by a data tool this turn." },
            label: { type: "string", minLength: 1 },
            hint: { type: "string" },
            follow_up_text: { type: "string", minLength: 1 },
          },
          required: ["entity_id", "label", "follow_up_text"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "entity_type", "options"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, error: "EMPTY_TITLE" };
    const entityTypeRaw = args.entity_type;
    const entityType: ClarificationBlock["entityType"] =
      entityTypeRaw === "customer" ||
      entityTypeRaw === "employee" ||
      entityTypeRaw === "generic"
        ? (entityTypeRaw as ClarificationBlock["entityType"])
        : "product";
    const optionsRaw = Array.isArray(args.options) ? args.options : [];
    const options: ClarificationOption[] = optionsRaw
      .map((o): ClarificationOption | null => {
        if (!o || typeof o !== "object") return null;
        const rec = o as Record<string, unknown>;
        const entityId = String(rec.entity_id ?? "").trim();
        const label = String(rec.label ?? "").trim();
        const followUpText = String(rec.follow_up_text ?? "").trim();
        if (!entityId || !label || !followUpText) return null;
        const hint = typeof rec.hint === "string" ? rec.hint : undefined;
        return { entityId, label, followUpText, ...(hint ? { hint } : {}) };
      })
      .filter((x): x is ClarificationOption => x !== null);
    if (options.length < 2) return { ok: false, error: "TOO_FEW_OPTIONS" };
    const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
    const block: AiBlock = {
      kind: "clarification",
      title,
      ...(prompt ? { prompt } : {}),
      entityType,
      options,
    };
    return { ok: true, blocks: [block] };
  },
};

/**
 * render_comparison — compare 2-4 products side-by-side.
 *
 * The LLM only names which products to compare (by uuid). The server rebuilds
 * the matrix from the current catalog so prices/stock are never fabricated.
 * If product data drifted since the search tool call, the SERVER values win.
 */
export const renderComparison: Tool = {
  name: "render_comparison",
  description:
    "Compare 2-4 products side-by-side. Pass product_ids (uuids returned by search_products / get_product this turn). The server builds the comparison matrix deterministically — prices, stock, brand, and SKU come from the live database, never from your estimate.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      product_ids: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" },
      },
    },
    required: ["product_ids"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const rawIds = Array.isArray(args.product_ids) ? args.product_ids : [];
    const ids = rawIds.map((v) => String(v).trim()).filter(Boolean);
    if (ids.length < 2) return { ok: false, error: "TOO_FEW_IDS" };
    // Server-side fetch — the LLM's numbers never touch the block.
    const { listProducts } = await import("@/lib/repo/catalog");
    const all = await listProducts(ctx.tenantId, null);
    const byId = new Map(all.map((p) => [p.id, p]));
    const picked: ComparisonProductInput[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (!p) continue;
      picked.push({
        id: p.id,
        name: p.name,
        brand: p.brand ?? null,
        sku: p.sku ?? null,
        price: Number(p.price),
        quantity: p.quantity,
        lowStockThreshold: p.lowStockThreshold,
      });
    }
    if (picked.length < 2) {
      const warn: WarningBlock = {
        kind: "warning",
        severity: "warning",
        title: ctx.locale === "ar" ? "مقارنة غير ممكنة" : "Comparison not possible",
        message:
          ctx.locale === "ar"
            ? "تعذّر تحديد منتجين صالحين للمقارنة. تأكد من الهوية الصحيحة."
            : "Could not find two valid products to compare.",
        code: "COMPARISON_LOOKUP_FAILED",
      };
      return { ok: true, blocks: [warn] };
    }
    const title = typeof args.title === "string" && args.title.trim() ? args.title : undefined;
    const block = buildProductComparison(picked, ctx.locale, title);
    return { ok: true, blocks: [block] };
  },
};

/**
 * render_inventory_summary — deterministic server-built inventory headline.
 * The LLM asks for the block; the server computes every number from
 * listProducts() + the item's low-stock threshold. No arithmetic in-model.
 */
export const renderInventorySummary: Tool = {
  name: "render_inventory_summary",
  description:
    "Show an inventory headline (total products, low-stock count, out-of-stock count, retail stock value, and up to a few urgent items). The server computes every number from the live catalog — you only ask for the block. Use for 'how's my stock', 'inventory summary', 'ملخص المخزون'.",
  parameters: {
    type: "object",
    properties: {
      highlight_limit: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        description: "Max urgent items to highlight (default 3).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const highlightLimit =
      typeof args.highlight_limit === "number"
        ? Math.max(0, Math.min(10, Math.floor(args.highlight_limit)))
        : 3;
    const block = await buildInventorySummary({
      tenantId: ctx.tenantId,
      branchId: null,
      locale: ctx.locale,
      highlightLimit,
    });
    return { ok: true, blocks: [block] };
  },
};

/**
 * render_sales_summary — deterministic server-built sales headline for a
 * period. Period validation + arithmetic (revenue, orders, AOV, trend) all
 * happen server-side.
 */
export const renderSalesSummary: Tool = {
  name: "render_sales_summary",
  description:
    "Show a sales headline (revenue, orders, AOV, trend vs previous period, top product) for the requested period. The server computes every number from the sales repo — you only pick the period. Use for 'how are sales today', 'مبيعات الأسبوع', 'شهر ازاي'.",
  parameters: {
    type: "object",
    properties: {
      period: {
        type: "string",
        enum: ["today", "yesterday", "week", "month", "quarter", "year", "all"],
      },
    },
    required: ["period"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const period = parsePeriod(args.period);
    const block = await buildSalesSummary({
      tenantId: ctx.tenantId,
      branchId: null,
      locale: ctx.locale,
      period,
    });
    return { ok: true, blocks: [block] };
  },
};

/**
 * render_warning — surface a user-visible notice. `code` is a stable
 * machine-readable identifier for mobile telemetry. Use when a metric is
 * unavailable, data is partial, or the user asked for something the system
 * can't do yet — NEVER as a substitute for refusing an invalid write.
 */
export const renderWarning: Tool = {
  name: "render_warning",
  description:
    "Surface a user-visible notice: 'this metric isn't tracked', 'that branch has no data this period', 'your reference was ambiguous', etc. Severity: info / warning / error. CODE is a stable SNAKE_CASE identifier (METRIC_UNAVAILABLE, PARTIAL_DATA, STALE_REFERENCE…). Never use for refusing writes — writes refuse themselves via the preview path.",
  parameters: {
    type: "object",
    properties: {
      severity: { type: "string", enum: ["info", "warning", "error"] },
      title: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      code: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9_]*$",
        description: "Stable SNAKE_CASE code for telemetry.",
      },
    },
    required: ["severity", "title", "message", "code"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const severity: WarningBlock["severity"] =
      args.severity === "info" || args.severity === "error"
        ? (args.severity as WarningBlock["severity"])
        : "warning";
    const title = String(args.title ?? "").trim();
    const message = String(args.message ?? "").trim();
    const code = String(args.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!title || !message || !code) return { ok: false, error: "EMPTY_WARNING" };
    const block: AiBlock = { kind: "warning", severity, title, message, code };
    return { ok: true, blocks: [block] };
  },
};

/**
 * render_knowledge_answer — F9 grounded answer with server-validated citations.
 *
 * The model composes a prose answer from the <EVIDENCE>…</EVIDENCE> chunks
 * returned by search_knowledge AND names the source chunk IDs it used. The
 * grounding guard (grounding.ts) drops any citation whose chunk_id wasn't
 * retrieved this turn — the mobile client only ever sees verified sources.
 */
export const renderKnowledgeAnswer: Tool = {
  name: "render_knowledge_answer",
  description:
    "Emit the final grounded answer to a knowledge/policy question. `answer` is your prose reply in the LOCKED user language. `sources` is the list of chunk IDs from search_knowledge that support the answer — the server verifies each chunk_id corresponds to a real chunk returned this turn and DROPS fabricated ones. Only use this AFTER calling search_knowledge. If search_knowledge returned no HIGH/MEDIUM hits, DO NOT call render_knowledge_answer — instead call render_text saying the knowledge base has no matching document (in the user's language).",
  parameters: {
    type: "object",
    properties: {
      answer: { type: "string", minLength: 1 },
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            chunk_id: { type: "string", description: "uuid returned by search_knowledge this turn." },
          },
          required: ["chunk_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["answer", "sources"],
    additionalProperties: false,
  },
  async handler(_ctx, args) {
    const answer = String(args.answer ?? "").trim();
    if (!answer) return { ok: false, error: "EMPTY_ANSWER" };
    const rawSources = Array.isArray(args.sources) ? args.sources : [];
    // Only the chunk_id is required at this stage — the grounding guard will
    // enrich with title/version/section from the retrieval index (the model
    // must NEVER be allowed to invent those fields). We stash a stub here;
    // grounding.ts fills them in.
    const sources = rawSources
      .map((s) => {
        if (!s || typeof s !== "object") return null;
        const id = String((s as Record<string, unknown>).chunk_id ?? "").trim();
        return id ? id : null;
      })
      .filter((x): x is string => x !== null);
    if (sources.length === 0) return { ok: false, error: "NO_SOURCES" };
    const block: AiBlock = {
      kind: "knowledge_answer",
      answer,
      // Stubbed — enforceGrounding will replace with validated KnowledgeSource[].
      sources: sources.map((id) => ({
        documentId: "",
        chunkId: id,
        title: "",
        version: 0,
        section: null,
        tier: "LOW" as const,
      })),
    };
    return { ok: true, blocks: [block] };
  },
};

export const RENDER_TOOLS: Tool[] = [
  renderText,
  renderChart,
  renderTable,
  renderKpi,
  renderProductCard,
  renderClarification,
  renderComparison,
  renderInventorySummary,
  renderSalesSummary,
  renderWarning,
  renderKnowledgeAnswer,
];

export function isRenderTool(name: string): boolean {
  return name.startsWith(RENDER_TOOL_PREFIX);
}
