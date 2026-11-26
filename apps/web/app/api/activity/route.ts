import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  listActivity,
  listActivityActors,
  type ActivityCategory,
} from "@/lib/repo/activity";
import { ACTIVITY_CATEGORIES } from "@/lib/activity-labels";

// One list with the page's filter chips (ACTIVITY_CATEGORIES), so a new
// category (e.g. `collection`, digital collections 05 §4.18) is filterable.
const VALID_CATEGORIES: readonly ActivityCategory[] = ACTIVITY_CATEGORIES;

function parseDate(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isFinite(d.valueOf()) ? d : undefined;
}

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_activity_log");
  if (!r.ok) return r.response;

  const url = req.nextUrl;
  const params = url.searchParams;
  const categoryRaw = params.get("category");
  const category =
    categoryRaw && VALID_CATEGORIES.includes(categoryRaw as ActivityCategory)
      ? (categoryRaw as ActivityCategory)
      : undefined;

  const [rows, actors] = await Promise.all([
    listActivity(r.ctx.tenantId, {
      from: parseDate(params.get("from")),
      to: parseDate(params.get("to")),
      actorUserId: params.get("actor") || undefined,
      category,
      before: parseDate(params.get("before")),
      limit: Math.min(Number(params.get("limit") ?? 50) || 50, 200),
    }),
    listActivityActors(r.ctx.tenantId),
  ]);

  return NextResponse.json({ rows, actors });
}
