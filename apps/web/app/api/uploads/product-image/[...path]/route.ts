import { NextRequest, NextResponse } from "next/server";
import { stat, readFile } from "node:fs/promises";
import { mimeFromPath, resolveTenantUpload } from "@/lib/uploads";

/**
 * Serves a product photo. Unlike /api/uploads/team (employee photos, ID scans)
 * this is deliberately unauthenticated: product images are not sensitive, the
 * cashier's POS and the mobile app's <Image> cannot attach a rotating bearer
 * to an image request, and receipts/exports may embed them. Access control is
 * the capability URL — a random UUID filename under the tenant's directory.
 * Only the `<tenant>/products/<uuid>.<ext>` shape is served, so an employee
 * photo (stored at `<tenant>/<uuid>.<ext>`) can never be reached through here.
 */
const SHAPE = /^[A-Za-z0-9-]+\/products\/[A-Za-z0-9-]+\.(jpg|png|webp)$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const relativePath = (path ?? []).join("/");
  if (!SHAPE.test(relativePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tenantId = path[0];
  const absolute = resolveTenantUpload(tenantId, relativePath);
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
      // Filenames are immutable UUIDs — a replaced photo gets a new URL.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
