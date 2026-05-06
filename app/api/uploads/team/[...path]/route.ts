import { NextRequest, NextResponse } from "next/server";
import { stat, readFile } from "node:fs/promises";
import { requirePermission } from "@/lib/api/auth-helpers";
import { mimeFromPath, resolveTenantUpload } from "@/lib/uploads";

/**
 * Authenticated streaming of an uploaded employee photo. The first segment of
 * the URL path must equal the caller's tenantId, otherwise 403. We don't even
 * need to hit the DB — possessing the URL plus belonging to that tenant is
 * authorization enough, since the URL was only ever issued to a member of that
 * tenant.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const { path } = await params;
  if (!path || path.length < 2) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [tenantSegment, ...rest] = path;
  if (tenantSegment !== r.ctx.tenantId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const relativePath = `${tenantSegment}/${rest.join("/")}`;
  const absolute = resolveTenantUpload(r.ctx.tenantId, relativePath);
  if (!absolute) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await stat(absolute);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data = await readFile(absolute);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": mimeFromPath(relativePath),
      "Cache-Control": "private, max-age=300",
    },
  });
}
