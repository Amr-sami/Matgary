import type { AiBlock } from "../responses";

/**
 * Structural de-duplication for AiBlocks inside a single agent turn.
 *
 * ROOT-CAUSE guard for regressions where the model loops across multiple
 * rounds and re-calls the same render_* tool (same productId, same text, …).
 * Before this helper, every tool-result's blocks were pushed to
 * `renderedBlocks` unconditionally — so one product question could emit the
 * same product_card + description 2–3 times.
 *
 * Identity by block kind + the stable cell that identifies "same thing" to
 * a user. Unknown kinds fall through to a JSON-stable hash. Pure — no side
 * effects.
 */
export function dedupKey(block: AiBlock): string {
  const b = block as AiBlock & { kind: string };
  switch (b.kind) {
    case "text":
      return `text:${normaliseText(b.text)}`;
    case "product_card":
      return `product_card:${b.productId}`;
    case "kpi":
      return `kpi:${(b.items ?? [])
        .map((i: { label: string; value: string }) => `${i.label}=${i.value}`)
        .join("|")}`;
    case "chart":
      return `chart:${b.title ?? ""}:${(b.series ?? [])
        .map((s: { dataKey: string }) => s.dataKey)
        .join("|")}`;
    case "table":
      return `table:${b.title ?? ""}:${(b.columns ?? [])
        .map((c: { key: string }) => c.key)
        .join("|")}:${b.rows?.length ?? 0}`;
    case "confirmation":
      return `confirmation:${b.token}`;
    case "clarification":
      return `clarification:${b.title}:${b.options
        .map((o: { entityId: string }) => o.entityId)
        .join("|")}`;
    case "comparison":
      return `comparison:${b.entities
        .map((e: { entityId: string }) => e.entityId)
        .join("|")}:${b.attributes.map((a: { label: string }) => a.label).join("|")}`;
    case "inventory_summary":
      return `inventory_summary:${b.title}`;
    case "sales_summary":
      return `sales_summary:${b.title}:${b.periodLabel ?? ""}`;
    case "warning":
      return `warning:${b.code}:${normaliseText(b.message)}`;
    case "knowledge_answer":
      return `knowledge_answer:${(b.sources ?? [])
        .map((s: { chunkId: string }) => s.chunkId)
        .join("|")}`;
    case "bulk_preview":
      return `bulk_preview:${b.operationKind}:${b.mode}:${b.value}`;
    case "bulk_result":
      return `bulk_result:${b.operationGroupId}`;
    case "import_preview":
    // editable_import_preview is added in a later step; same identity rule.
    // eslint-disable-next-line no-fallthrough
    case "editable_import_preview":
      return `${b.kind}:${b.sessionId}`;
    case "import_question":
      return `import_question:${b.sessionId}`;
    case "import_result":
      return `import_result:${b.sessionId}`;
    case "import_conflict":
      return `import_conflict:${b.sessionId}`;
    case "rollback_preview":
      return `rollback_preview:${b.operationId}`;
    case "rollback_result":
      return `rollback_result:${b.operationId}`;
    case "rollback_conflict":
      return `rollback_conflict:${b.operationId}`;
    default:
      // Future-proof: any new block kind without an explicit case still gets
      // a stable identity so it can't silently duplicate.
      return `unknown:${stableHash(b)}`;
  }
}

/**
 * Append `next` blocks to `existing` in order, skipping any that collide
 * with a block already present (by dedupKey). First occurrence wins so the
 * model's initial render stays and any accidental re-render in a later round
 * is silently dropped.
 */
export function mergeDedup(existing: AiBlock[], next: AiBlock[]): AiBlock[] {
  const seen = new Set<string>(existing.map(dedupKey));
  const out = existing.slice();
  for (const b of next) {
    const key = dedupKey(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/** De-duplicate a single array of blocks in order (first wins). */
export function dedupBlocks(blocks: AiBlock[]): AiBlock[] {
  const seen = new Set<string>();
  const out: AiBlock[] = [];
  for (const b of blocks) {
    const key = dedupKey(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

function normaliseText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function stableHash(value: unknown): string {
  // FNV-1a over a key-ordered JSON string. Not cryptographic — we only need
  // stable identity across one turn.
  const json = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
