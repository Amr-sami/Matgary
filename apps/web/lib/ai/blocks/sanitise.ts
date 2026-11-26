/**
 * F11 — text-block safety net.
 *
 * ROOT-CAUSE guard against the "raw JSON shown as chat text" class of bug.
 *
 * The LLM is told to call render_* tools via the structured tool-call channel;
 * when a provider (gpt-oss, some Gemini responses) leaks the tool call as
 * plain text content instead, the agent's `salvageLeakedRenderCalls` tries to
 * re-execute it. When salvage fails — because the leaked payload names a
 * render tool outside the salvage allowlist, or the JSON is malformed, or the
 * model concatenated multiple partial objects — the content still falls
 * through to `return [{ kind: "text", text: fallbackText }]`, and the user
 * sees raw `{"name":"render_warning",…}` in a chat bubble.
 *
 * `looksLikeStructuredLeak` detects that pattern. `sanitiseText` either
 * returns the text unchanged, or (on detection) swaps it for a localised
 * safe fallback.
 *
 * Pure. No side effects. Tested in isolation.
 */

import type { Locale } from "../language";
import { tr } from "../i18n";

/** Render / preview tool names the LLM could leak as JSON. Kept in one list
 *  so adding a new tool automatically lights up the detector. */
const KNOWN_TOOL_NAMES = [
  // render.ts
  "render_text",
  "render_chart",
  "render_table",
  "render_kpi",
  "render_product_card",
  "render_clarification",
  "render_comparison",
  "render_inventory_summary",
  "render_sales_summary",
  "render_warning",
  "render_knowledge_answer",
  // write-staging previews
  "preview_update_product_price",
  "preview_update_product_quantity",
  "preview_create_customer",
  "preview_import",
  // data tools (leaked tool-call JSON for these is equally bad)
  "search_products",
  "get_product",
  "search_knowledge",
  "inspect_import",
] as const;

/** Block kind strings used when the LLM leaks a built block instead of a
 *  tool call. */
const KNOWN_BLOCK_KINDS = [
  "text",
  "chart",
  "table",
  "kpi",
  "product_card",
  "confirmation",
  "clarification",
  "comparison",
  "inventory_summary",
  "sales_summary",
  "warning",
  "knowledge_answer",
  "import_preview",
  "editable_import_preview",
  "import_question",
  "import_result",
  "bulk_preview",
  "bulk_result",
  "rollback_preview",
  "rollback_result",
] as const;

/**
 * True when `text` looks like a structured tool-call or block JSON that
 * accidentally reached the text channel.
 *
 * Detection is intentionally over-broad: false positives (plain prose that
 * happens to mention `render_text`) are infinitely better than false
 * negatives (JSON in a chat bubble). Prose rarely contains `"kind":` or
 * `"name":` in a JSON-ish shape.
 */
export function looksLikeStructuredLeak(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Fast path: starts with { or [ AND contains one of the known identifiers.
  // Covers `{"name":"render_warning",…}` and `[{"kind":"product_card",…}]`.
  if (/^[\[\{]/.test(trimmed)) {
    if (
      /"kind"\s*:\s*"/.test(trimmed) ||
      /"name"\s*:\s*"/.test(trimmed) ||
      /"tool_calls"\s*:/.test(trimmed) ||
      /"arguments"\s*:/.test(trimmed) ||
      /"function_call"\s*:/.test(trimmed)
    ) {
      return true;
    }
  }

  // Function-call shaped leak — `render_text({"text":"hi"})` or
  // `preview_update_product_price(product_id="…", new_price=…)`.
  for (const name of KNOWN_TOOL_NAMES) {
    const re = new RegExp(`\\b${name}\\s*\\(`);
    if (re.test(trimmed)) return true;
  }

  // Block-shaped leak anywhere in the text — `"kind": "product_card"` with
  // adjacent JSON punctuation.
  const kindMatch = trimmed.match(/"kind"\s*:\s*"([a-z_]+)"/);
  if (kindMatch && (KNOWN_BLOCK_KINDS as readonly string[]).includes(kindMatch[1]!)) {
    // Confirm it's inside something JSON-shaped (has a nearby `{` or `}`).
    if (/[\{\}]/.test(trimmed)) return true;
  }

  // Tool-arguments leak.
  if (/"arguments"\s*:\s*[\{"]/.test(trimmed)) return true;

  return false;
}

/**
 * If `text` looks like a structured leak, return a safe localised fallback.
 * Otherwise return the original text unchanged.
 *
 * The fallback is deliberately vague — "I couldn't format that response" —
 * because we do not know what the model intended. The original payload is
 * logged server-side at the caller so engineers can debug without exposing
 * implementation details to the end user.
 */
export function sanitiseText(text: string, locale: Locale): string {
  if (!looksLikeStructuredLeak(text)) return text;
  return tr("nudge.sanitised", locale);
}

/**
 * Wrap `sanitiseText` for ergonomics: callers that build a text block can
 * pass the raw content and get a clean block back.
 */
export function sanitisedTextBlock(
  text: string,
  locale: Locale,
): { kind: "text"; text: string } {
  return { kind: "text", text: sanitiseText(text, locale) };
}
