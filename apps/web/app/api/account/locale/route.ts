import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import { bustUserContextCache } from "@/lib/auth";
import { logActivity } from "@/lib/repo/activity";

// PATCH /api/account/locale — change the caller's UI language preference.
//
// Phase 2 i18n. The locale rides on every JWT (added in lib/auth.ts), so
// the row update + cache bust is enough for the next request to render in
// the new language. We deliberately do NOT bump `token_version` here: locale
// is a preference, not a security event, so we don't want to log the user
// out of other devices. Other live sessions pick up the new locale on their
// next navigation via the jwt-callback refresh path.

const schema = z.object({
  locale: z.enum(["ar", "en"]),
});

export async function PATCH(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_LOCALE" }, { status: 400 });
  }

  try {
    await db
      .update(users)
      .set({ locale: parsed.data.locale })
      .where(eq(users.id, r.ctx.userId));
    await bustUserContextCache(r.ctx.userId);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "settings.locale_change",
      category: "settings",
      entityType: "user",
      entityId: r.ctx.userId,
      metadata: { locale: parsed.data.locale },
    });
    return NextResponse.json({ ok: true, locale: parsed.data.locale });
  } catch (err) {
    console.error("[locale] update failed:", err);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
