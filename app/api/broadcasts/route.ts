// Tenant-side broadcast read. Requires a tenant session so we can filter by
// audience (owners vs staff vs all). Anonymous callers get an empty list —
// the public landing page doesn't render broadcasts and the auth gate is
// applied by middleware before this route runs.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getActiveBroadcasts } from "@/lib/broadcasts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth().catch(() => null);
  if (!session?.user) {
    return NextResponse.json({ data: [] });
  }
  // Anyone whose tenant_members.role is 'owner' counts as 'owner' for the
  // audience filter; everyone else (staff, ops users on this tenant) is
  // 'staff'.
  const role = session.user.role === "owner" ? "owner" : "staff";
  const data = await getActiveBroadcasts(role);
  return NextResponse.json(
    { data },
    {
      headers: {
        // Edge: 60s cached, 120s stale-while-revalidate. Edits at
        // /admin/broadcasts bust the in-memory cache in lib/broadcasts.ts
        // independently so users see the fresh state within a second.
        "Cache-Control":
          "private, s-maxage=60, stale-while-revalidate=120, max-age=0",
      },
    },
  );
}
