import { NextRequest, NextResponse } from "next/server";
import { inspectResetToken } from "@/lib/repo/password-reset";

// Pre-validation endpoint: the reset page calls this on mount so we can
// tell the user "this link is dead" BEFORE they fill in a new password
// twice. Read-only — does NOT extend the token's TTL, does NOT consume it.
//
// Public route (the user clicking the email link isn't logged in). Adds
// no enumeration risk beyond what consumeResetToken would already leak,
// because a "valid: false" response could equally mean "token expired" or
// "we never issued this token in the first place" — same as the POST.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const valid = await inspectResetToken(token);
  return NextResponse.json({ valid });
}
