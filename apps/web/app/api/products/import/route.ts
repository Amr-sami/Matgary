import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { can } from "@/lib/permissions";
import {
  commitImport,
  previewImport,
  type ImportContext,
} from "@/lib/repo/product-import";
import { logActivity } from "@/lib/repo/activity";

export const runtime = "nodejs";

// Two-phase bulk import:
//   - mode="preview": parse + validate, never write. The UI shows the
//     per-row plan (create / update / error) so the cashier sees exactly
//     what will happen before pulling the trigger.
//   - mode="commit":  re-runs validation server-side and writes when
//     every row is clean. A single bad row aborts the commit (better
//     than half-imported inventory).
//
// CSV is uploaded as a JSON string field rather than multipart/form-data
// because Next 16 route handlers expose multipart through web `Request`
// which is fine but verbose; for ≤2 MB CSVs the JSON wrapper is simpler
// and gzips well over the wire.
//
// Permission: `manage_inventory` — same as the single-product add path.

const schema = z.object({
  mode: z.enum(["preview", "commit"]),
  csv: z.string().min(1).max(2 * 1024 * 1024), // 2 MB cap — generous for ~10k rows
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  if (!can(r.ctx, "manage_inventory")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "بيانات غير صالحة" },
      { status: 400 },
    );
  }

  const ctx: ImportContext = {
    tenantId: r.ctx.tenantId,
    branchId: r.ctx.branchId,
    actorUserId: r.ctx.userId,
  };

  if (parsed.data.mode === "preview") {
    const preview = await previewImport(ctx, parsed.data.csv);
    return NextResponse.json(preview);
  }

  // commit
  const result = await commitImport(ctx, parsed.data.csv);
  if (result.created > 0 || result.updated > 0) {
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "product.bulk_import",
      category: "product",
      branchId: r.ctx.branchId,
      metadata: {
        rows: result.rows,
        created: result.created,
        updated: result.updated,
        failed: result.failed,
      },
    });
  }
  return NextResponse.json(result);
}
