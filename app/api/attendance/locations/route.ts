import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  createStoreLocation,
  listStoreLocations,
} from "@/lib/repo/attendance";

export async function GET() {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const locations = await listStoreLocations(r.ctx.tenantId);
  return NextResponse.json({ locations });
}

const postSchema = z.object({
  name: z.string().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  geofenceRadiusM: z.number().int().min(10).max(2000).optional(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const location = await createStoreLocation(r.ctx.tenantId, parsed.data);
  return NextResponse.json({ location }, { status: 201 });
}
