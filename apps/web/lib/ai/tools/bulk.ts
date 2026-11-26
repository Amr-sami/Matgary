import { tr } from "../i18n";
import { BULK_LIMITS } from "../bulk/limits";
import {
  BulkError,
  computeBulkIntPreview,
  computeBulkPricePreview,
  resolveCandidates,
  type BulkPricePreview,
  type PriceMode,
  type ProductFilter,
} from "../bulk/products";
import type { AiBlock, BulkPreviewBlock } from "../responses";
import type { AiActionType } from "../write/pending";
import { createPending } from "../write/pending";

import type { Tool } from "./types";

/**
 * F10.3 — preview_bulk_price_update.
 *
 * The AI provides a filter + operation; the server resolves the candidate
 * set from the live catalog, computes before/after, and stages an F5
 * pending action with the EXACT changes baked in. Execution flows through
 * the normal /api/ai/confirm pipeline — see lib/ai/bulk/execute.ts.
 */

export const previewBulkPriceUpdate: Tool = {
  name: "preview_bulk_price_update",
  description:
    `PREVIEW a bulk price change across a filtered product set. The server
resolves the EXACT product list from the live catalog and computes
before/after values — you only name the filter + the operation. Safety caps:
max ${BULK_LIMITS.maxRecords} records per operation, max
${BULK_LIMITS.maxPercentChange}% change, max ${BULK_LIMITS.maxPriceDelta} EGP
absolute delta. Returns a BulkPreviewBlock + ConfirmationBlock — execution
only happens when the user confirms. Never claims success before confirm.`,
  requiredPermission: "manage_inventory",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: {
          brand: { type: "string", description: "Case-insensitive exact brand name." },
          product_ids: {
            type: "array",
            items: { type: "string" },
            maxItems: BULK_LIMITS.maxRecords,
          },
          low_stock: {
            type: "boolean",
            description: "When true, target only products at/below their low-stock threshold.",
          },
        },
        additionalProperties: false,
      },
      mode: {
        type: "string",
        enum: ["set", "increase_pct", "decrease_pct", "increase_by", "decrease_by"],
      },
      value: { type: "number", description: "Absolute amount (EGP) or percentage (0-100)." },
    },
    required: ["filter", "mode", "value"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const rawFilter = (args.filter ?? {}) as Record<string, unknown>;
    const filter: ProductFilter = {
      brand: typeof rawFilter.brand === "string" ? rawFilter.brand : undefined,
      productIds: Array.isArray(rawFilter.product_ids)
        ? (rawFilter.product_ids as unknown[]).map(String).slice(0, BULK_LIMITS.maxRecords)
        : undefined,
      lowStock: rawFilter.low_stock === true,
    };
    const mode = String(args.mode) as PriceMode;
    const value = Number(args.value);

    const candidates = await resolveCandidates({
      tenantId: ctx.tenantId,
      branchId: null,
      filter,
    });
    if (candidates.length === 0) {
      return {
        ok: true,
        blocks: [{ kind: "text", text: tr("bulk.nothingToDo", ctx.locale) }],
      };
    }

    let preview: BulkPricePreview;
    try {
      preview = computeBulkPricePreview({ candidates, mode, value });
    } catch (e) {
      if (e instanceof BulkError) {
        return {
          ok: true,
          blocks: [
            {
              kind: "text",
              text: tr("bulk.invalid", ctx.locale, { reason: e.message }),
            },
          ],
        };
      }
      throw e;
    }

    // Stage the F5 pending action with the EXACT computed changes. The
    // executor re-reads live state + enforces concurrency before each write.
    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "bulk_price_update",
      params: {
        mode,
        value,
        changes: preview.changes.map((c) => ({
          productId: c.productId,
          before: c.beforePrice,
          after: c.afterPrice,
        })),
      },
      preview: {
        locale: ctx.locale,
        operationKind: "product.price.update",
        totalMatched: preview.totalMatched,
        totalEligible: preview.totalEligible,
        mode,
        value,
      },
    });

    const block: BulkPreviewBlock = {
      kind: "bulk_preview",
      operationKind: "product.price.update",
      mode,
      value,
      totalMatched: preview.totalMatched,
      totalEligible: preview.totalEligible,
      skippedOverCap: preview.skippedOverCap,
      sampleChanges: preview.changes.slice(0, 6).map((c) => ({
        productId: c.productId,
        name: c.name,
        beforePrice: c.beforePrice,
        afterPrice: c.afterPrice,
        delta: c.delta,
      })),
      totalPriceDelta: preview.totalPriceDelta,
      title: tr("bulk.preview.title", ctx.locale),
      description:
        preview.skippedOverCap > 0
          ? tr("bulk.preview.overCap", ctx.locale, {
              matched: preview.totalMatched,
              cap: BULK_LIMITS.maxRecords,
            })
          : tr("bulk.preview.description", ctx.locale, {
              eligible: preview.totalEligible,
              matched: preview.totalMatched,
              totalDelta: preview.totalPriceDelta,
            }),
    };

    return {
      ok: true,
      blocks: [
        block,
        {
          kind: "confirmation",
          title: block.title,
          summary: block.description,
          actionLabel: tr("bulk.preview.actionLabel", ctx.locale),
          token: pending.token,
          expiresAt: pending.expiresAt,
        } satisfies AiBlock,
      ],
    };
  },
};

/* ─────────────── F10.3 (extended) — quantity + threshold ───────── */

/**
 * Shared implementation for the two integer-field bulk tools. The LLM-facing
 * schema is identical to preview_bulk_price_update; the internal field +
 * action name differ.
 */
function makeIntBulkTool(opts: {
  name: string;
  action: AiActionType;
  field: "quantity" | "lowStockThreshold";
  description: string;
}): Tool {
  return {
    name: opts.name,
    description: opts.description,
    requiredPermission: "manage_inventory",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            brand: { type: "string" },
            product_ids: {
              type: "array",
              items: { type: "string" },
              maxItems: BULK_LIMITS.maxRecords,
            },
            low_stock: { type: "boolean" },
          },
          additionalProperties: false,
        },
        mode: {
          type: "string",
          enum: ["set", "increase_pct", "decrease_pct", "increase_by", "decrease_by"],
        },
        value: { type: "number" },
      },
      required: ["filter", "mode", "value"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const rawFilter = (args.filter ?? {}) as Record<string, unknown>;
      const filter: ProductFilter = {
        brand: typeof rawFilter.brand === "string" ? rawFilter.brand : undefined,
        productIds: Array.isArray(rawFilter.product_ids)
          ? (rawFilter.product_ids as unknown[]).map(String).slice(0, BULK_LIMITS.maxRecords)
          : undefined,
        lowStock: rawFilter.low_stock === true,
      };
      const mode = String(args.mode) as PriceMode;
      const value = Number(args.value);

      const candidates = await resolveCandidates({
        tenantId: ctx.tenantId,
        branchId: null,
        filter,
      });
      if (candidates.length === 0) {
        return {
          ok: true,
          blocks: [{ kind: "text", text: tr("bulk.nothingToDo", ctx.locale) }],
        };
      }
      let preview;
      try {
        preview = computeBulkIntPreview({
          candidates,
          mode,
          value,
          field: opts.field,
        });
      } catch (e) {
        if (e instanceof BulkError) {
          return {
            ok: true,
            blocks: [
              { kind: "text", text: tr("bulk.invalid", ctx.locale, { reason: e.message }) },
            ],
          };
        }
        throw e;
      }

      const pending = await createPending({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        branchId: null,
        action: opts.action,
        params: {
          field: opts.field,
          mode,
          value,
          changes: preview.changes.map((c) => ({
            productId: c.productId,
            before: c.before,
            after: c.after,
          })),
        },
        preview: {
          locale: ctx.locale,
          field: opts.field,
          totalMatched: preview.totalMatched,
          totalEligible: preview.totalEligible,
          mode,
          value,
        },
      });

      const block: BulkPreviewBlock = {
        kind: "bulk_preview",
        operationKind: "product.price.update", // reuse single UI block type; UI shows counts
        mode,
        value,
        totalMatched: preview.totalMatched,
        totalEligible: preview.totalEligible,
        skippedOverCap: preview.skippedOverCap,
        sampleChanges: preview.changes.slice(0, 6).map((c) => ({
          productId: c.productId,
          name: c.name,
          beforePrice: c.before,
          afterPrice: c.after,
          delta: c.delta,
        })),
        totalPriceDelta: preview.totalDelta,
        title: tr("bulk.preview.title", ctx.locale),
        description:
          preview.skippedOverCap > 0
            ? tr("bulk.preview.overCap", ctx.locale, {
                matched: preview.totalMatched,
                cap: BULK_LIMITS.maxRecords,
              })
            : tr("bulk.preview.description", ctx.locale, {
                eligible: preview.totalEligible,
                matched: preview.totalMatched,
                totalDelta: preview.totalDelta,
              }),
      };

      return {
        ok: true,
        blocks: [
          block,
          {
            kind: "confirmation",
            title: block.title,
            summary: block.description,
            actionLabel: tr("bulk.preview.actionLabel", ctx.locale),
            token: pending.token,
            expiresAt: pending.expiresAt,
          } satisfies AiBlock,
        ],
      };
    },
  };
}

export const previewBulkQuantityUpdate: Tool = makeIntBulkTool({
  name: "preview_bulk_quantity_update",
  action: "bulk_quantity_update",
  field: "quantity",
  description:
    `PREVIEW a bulk QUANTITY change across a filtered product set. Same server-driven
candidate resolution + concurrency-safe execution as preview_bulk_price_update, but writes
the \`quantity\` field. Safety caps: max ${BULK_LIMITS.maxRecords} records,
max ${BULK_LIMITS.maxPercentChange}% change, max ${BULK_LIMITS.maxQuantityDelta} absolute delta.
Returns BulkPreviewBlock + ConfirmationBlock.`,
});

export const previewBulkThresholdUpdate: Tool = makeIntBulkTool({
  name: "preview_bulk_threshold_update",
  action: "bulk_threshold_update",
  field: "lowStockThreshold",
  description:
    `PREVIEW a bulk LOW-STOCK-THRESHOLD change across a filtered product set. Writes
the \`lowStockThreshold\` field. Same safety caps + confirmation path.
NOTE: threshold writes record the operation but are NOT individually reversible — an
"undo that" will skip them. The threshold change is still safe + verifiable.`,
});
