// GET /api/whatsapp/templates?status=approved&category=utility&includeStale=1
//
// Lists the tenant's cached message templates (read from wa_templates).
// Defaults exclude stale rows.

import { NextResponse, type NextRequest } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import {
  listTemplates,
  type TemplateCategory,
  type TemplateStatus,
} from "@/lib/whatsapp/templates";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") ?? "all") as TemplateStatus | "all";
  const category = (url.searchParams.get("category") ?? "all") as
    | TemplateCategory
    | "all";
  const includeStale = url.searchParams.get("includeStale") === "1";

  const rows = await listTemplates(auth.ctx.tenantId, auth.ctx.branchId, {
    status,
    category,
    includeStale,
  });

  return NextResponse.json({
    ok: true,
    count: rows.length,
    templates: rows.map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      components: t.components,
      qualityScore: t.qualityScore,
      rejectedReason: t.rejectedReason,
      parameterFormat: t.parameterFormat,
      lastSyncedAt: t.lastSyncedAt,
    })),
  });
}
