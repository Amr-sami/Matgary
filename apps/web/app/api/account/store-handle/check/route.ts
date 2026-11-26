import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";

// Public endpoint: returns whether a slug is currently free or taken.
// Used by the signup form for live availability feedback. Rate-limit later
// if abuse becomes a concern; for now the lookup is cheap and indexed.
export async function GET(req: NextRequest) {
  const handle = (req.nextUrl.searchParams.get("handle") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(handle) || handle.length > 40) {
    return NextResponse.json({ available: false, reason: "invalid" });
  }
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, handle))
    .limit(1);
  return NextResponse.json({ available: !row });
}
