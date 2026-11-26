import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import { renameStoreHandle, TeamConflictError } from "@/lib/repo/team";

const schema = z.object({
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i),
});

export async function POST(req: NextRequest) {
  // Renaming the handle changes every staff login — gate as owner-only via
  // the manage_team permission (which only owners hold by default).
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    await renameStoreHandle(r.ctx.tenantId, parsed.data.handle);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
