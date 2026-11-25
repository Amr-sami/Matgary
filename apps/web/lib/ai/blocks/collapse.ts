import type { AiBlock, TextBlock } from "../responses";

/**
 * F11 — ONE-TURN INVARIANT.
 *
 * The chat pipeline already enforces "one user turn → one assistant turn" at
 * the HTTP/state level: one POST /api/ai/chat returns one AgentResponse which
 * becomes one AssistantMessage in the mobile state array. The user, however,
 * experiences a turn as a sequence of visually-separate bubbles (one per
 * AiBlock the MessageRow renders).
 *
 * When the model calls `render_text` multiple times in a single turn —
 * common when it's trying to greet, explain, and summarise all at once —
 * those N text blocks render as N stacked paragraphs that look like N
 * separate messages. This helper collapses them to ONE text block so the
 * visible turn maps 1-to-1 to the logical turn.
 *
 * Rules:
 *   • All `text` blocks are merged into a single `text` block in FIRST
 *     position (joined with a double newline, whitespace-normalised).
 *   • Every structured block kind (product_card, kpi, chart, table,
 *     confirmation, clarification, comparison, inventory_summary,
 *     sales_summary, warning, knowledge_answer, bulk_preview, bulk_result,
 *     editable_import_preview, import_*, rollback_*) is kept.
 *   • Order: the merged text first, then structured blocks in their
 *     original order.
 *   • If there are no text blocks, structured blocks are returned as-is.
 *
 * Pure. No side effects. Does NOT dedup — that is `dedupBlocks`'s job and
 * runs first in the agent pipeline. The sequence is:
 *     mergeDedup during loop → dedupBlocks in finalBlocks → collapseTurn
 */

/** Collapse multiple text blocks in a single turn into one. Structured
 *  blocks are preserved. Order: merged text first, then structured blocks
 *  in their input order. */
export function collapseTurn(blocks: AiBlock[]): AiBlock[] {
  if (blocks.length <= 1) return blocks;
  const texts: TextBlock[] = [];
  const structured: AiBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      texts.push(b);
    } else {
      structured.push(b);
    }
  }
  if (texts.length <= 1) {
    // Already single-text (or zero-text) — nothing to merge. Preserve
    // ordering: text (if any) stays first.
    if (texts.length === 0) return structured;
    return [texts[0]!, ...structured];
  }
  const joined = joinTexts(texts.map((t) => t.text));
  const merged: TextBlock = { kind: "text", text: joined };
  return [merged, ...structured];
}

/**
 * Merge N text snippets into one, deduplicating consecutive identical
 * sentences (the model sometimes restates its last paragraph) and
 * collapsing whitespace.
 */
function joinTexts(texts: string[]): string {
  const normalised = texts
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  if (normalised.length === 0) return "";
  // Drop later entries that are a strict prefix/suffix of the previous one
  // (common when the model repeats itself in a second render_text call).
  const deduped: string[] = [];
  for (const s of normalised) {
    const last = deduped[deduped.length - 1];
    if (!last) {
      deduped.push(s);
      continue;
    }
    if (last.includes(s) || s.includes(last)) {
      // Keep the longer one in `last`'s slot.
      if (s.length > last.length) deduped[deduped.length - 1] = s;
      continue;
    }
    deduped.push(s);
  }
  return deduped.join("\n\n");
}
