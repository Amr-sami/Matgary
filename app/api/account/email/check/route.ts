import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Public endpoint: returns whether an email is currently free or already
// registered. Used by the signup form for live availability feedback so
// the user finds out at step 1 (email + password) instead of step 2
// (after they've also filled in store name + handle). Mirrors the
// /api/account/store-handle/check shape.
export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!raw || raw.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return NextResponse.json({ available: false, reason: "invalid" });
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, raw))
    .limit(1);
  return NextResponse.json({ available: !row });
}
