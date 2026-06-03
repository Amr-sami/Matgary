import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireTenant } from "@/lib/api/auth-helpers";
import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import { scheduleDeletion } from "@/lib/repo/tenant-deletion";
import { logActivity } from "@/lib/repo/activity";
import { rateLimit } from "@/lib/ratelimit";

const schema = z.object({
  confirmSlug: z.string().min(1).max(80),
});

// POST /api/account/delete — schedule deletion for owner's tenant in 30 days.
// Confirmation requires the user to type the tenant slug; rate-limit prevents
// the modal from being weaponised (3 / 24 h / user).
const DELETE_LIMIT = 3;
const DELETE_WINDOW_SEC = 24 * 60 * 60;

export async function POST(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  if (r.ctx.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const rl = await rateLimit("account.delete", r.ctx.userId, {
    limit: DELETE_LIMIT,
    windowSec: DELETE_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "محاولات كثيرة" }, { status: 429 });
  }
  const [t] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, r.ctx.tenantId))
    .limit(1);
  if (!t || t.slug !== parsed.data.confirmSlug.trim()) {
    return NextResponse.json({ error: "SLUG_MISMATCH" }, { status: 400 });
  }
  const scheduledAt = await scheduleDeletion(r.ctx.tenantId);
  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "tenant.deletion_scheduled",
    category: "settings",
    entityType: "tenant",
    entityId: r.ctx.tenantId,
    metadata: { scheduledAt: scheduledAt.toISOString() },
  });
  return NextResponse.json({ scheduledAt: scheduledAt.toISOString() });
}
