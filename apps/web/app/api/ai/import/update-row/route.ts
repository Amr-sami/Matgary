import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { listCategories } from "@/lib/repo/catalog";
import { getAdapter } from "@/lib/ai/import/adapters/products";
import type { AdapterContext, ProcessedRow } from "@/lib/ai/import/adapters/types";
import {
  buildEditableImportPreviewBlock,
} from "@/lib/ai/import/editable-preview";
import { revalidateRows } from "@/lib/ai/import/revalidate";
import {
  loadRowsWithIds,
  loadSession,
  replaceRows,
} from "@/lib/ai/import/session";
import { detectLocale } from "@/lib/ai/language";
import { newRequestId, redactError } from "@/lib/ai/telemetry";

/**
 * F11 — Per-row inline edit for an in-flight import session.
 *
 * The mobile editable preview PATCHes one row at a time as the user types.
 * The server:
 *   1. Loads the session (verifies ownership — same tenant + same user).
 *   2. Finds the target row by rowIndex.
 *   3. Merges the submitted field values into normalised[].
 *   4. Re-runs adapter.validateAndResolve on JUST that row so status/action
 *      reflect the new DB reality (a renamed SKU may now match a different
 *      existing product; a cleared required field flips the row invalid).
 *   5. Persists via replaceRows (recomputes session counts + status).
 *   6. Returns the fresh row + updated session counts so the client can
 *      patch its local state.
 *
 * SAFETY:
 *   • Requires `manage_inventory`. Ownership re-checked (tenantId + userId).
 *   • The LLM can never provide tenantId/userId/branchId — the request body
 *     only carries sessionId, rowIndex, and the fields to update.
 *   • Session status is NOT progressed here; execution still requires
 *     preview_import to stage the HMAC pending action and the user to
 *     confirm. Edits made after staging are picked up at execute time
 *     because executeImport re-loads the rows.
 *   • Field values are DATA. Nothing in the submitted payload is executed
 *     as an instruction.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  rowIndex: z.number().int().positive(),
  /** Cell values keyed by canonical field name. Server coerces + validates. */
  fields: z.record(z.string(), z.unknown()),
});

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const r = await requirePermission("manage_inventory");
  if (!r.ok) {
    r.response.headers.set("X-Ai-Request-Id", requestId);
    return r.response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", requestId }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "INVALID_BODY",
        reason: parsed.error.issues[0]?.message ?? "bad body",
        requestId,
      },
      { status: 400 },
    );
  }
  const { sessionId, rowIndex, fields } = parsed.data;

  try {
    const session = await loadSession({
      tenantId: r.ctx.tenantId,
      sessionId,
    });
    if (!session || session.userId !== r.ctx.userId) {
      return NextResponse.json(
        { error: "SESSION_NOT_FOUND", requestId },
        { status: 404 },
      );
    }
    // Reject edits on a session that's already been executed.
    if (
      session.status === "completed" ||
      session.status === "partially_completed" ||
      session.status === "failed" ||
      session.status === "importing"
    ) {
      return NextResponse.json(
        { error: "SESSION_CLOSED", status: session.status, requestId },
        { status: 409 },
      );
    }

    const withIds = await loadRowsWithIds({
      tenantId: r.ctx.tenantId,
      sessionId,
    });
    const target = withIds.find((row) => row.rowIndex === rowIndex);
    if (!target) {
      return NextResponse.json(
        { error: "ROW_NOT_FOUND", requestId },
        { status: 404 },
      );
    }

    // Merge submitted fields into normalised; coerce numbers from strings so
    // the adapter validator sees the canonical shape it expects.
    const mergedNormalised = coerceFields({
      ...target.normalised,
      ...fields,
    });

    const rows: ProcessedRow[] = withIds.map((row) => ({
      rowIndex: row.rowIndex,
      status: row.status,
      action: row.action,
      raw: row.raw,
      normalised:
        row.rowIndex === rowIndex ? mergedNormalised : row.normalised,
      resolution: row.resolution,
      errors: row.errors,
      issues: row.issues,
    }));

    const locale = detectLocale([{ role: "user", content: "" }], "en");
    const adapterCtx: AdapterContext = {
      tenantId: r.ctx.tenantId,
      userId: r.ctx.userId,
      branchId: null,
      locale,
    };
    const revalidated = await revalidateRows({
      entityType: session.entityType,
      rows,
      ctx: adapterCtx,
      rowIndexes: new Set([rowIndex]),
    });
    await replaceRows({
      tenantId: r.ctx.tenantId,
      sessionId,
      rows: revalidated,
    });

    // Build a fresh editable block over the WHOLE session — the client uses
    // it to reconcile counts + status chips. Cheaper than refetching from
    // the client.
    const refreshedWithIds = await loadRowsWithIds({
      tenantId: r.ctx.tenantId,
      sessionId,
    });
    const refreshed = await loadSession({
      tenantId: r.ctx.tenantId,
      sessionId,
    });
    const categoryLabels = (
      await listCategories(r.ctx.tenantId, null)
    ).map((c) => c.label);
    const block = buildEditableImportPreviewBlock({
      session: {
        id: sessionId,
        entityType: refreshed?.entityType ?? session.entityType,
        fileName: refreshed?.fileName ?? session.fileName,
        currency: null,
      },
      rows: refreshedWithIds,
      locale,
      categoryLabels,
    });

    const res = NextResponse.json({
      block,
      updatedRowIndex: rowIndex,
      requestId,
    });
    res.headers.set("X-Ai-Request-Id", requestId);
    return res;
  } catch (err) {
    console.error("[ai/import/update-row] failed", {
      requestId,
      tenantId: r.ctx.tenantId,
      reason: redactError(err),
    });
    return NextResponse.json(
      { error: "INTERNAL", requestId },
      { status: 500 },
    );
  }
}

/**
 * Normalise submitted cell values:
 *   • Strings that look like numbers (e.g. "1250.5") → number
 *   • Empty strings / "null" → null
 *   • null → null (unsets the field, which flips required rows to missing)
 *   • Otherwise pass through as string
 */
function coerceFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") {
      out[key] = null;
      continue;
    }
    if (typeof value === "number") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        out[key] = null;
        continue;
      }
      // Numeric-looking strings get coerced for known-number fields. We
      // deliberately only coerce when the whole string parses cleanly, so
      // "1,234" (comma-separated) stays a string and the validator surfaces
      // the formatting issue.
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        out[key] = Number(trimmed);
        continue;
      }
      out[key] = trimmed;
      continue;
    }
    out[key] = value;
  }
  return out;
}
