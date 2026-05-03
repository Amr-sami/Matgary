import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export type AuthedContext = { userId: string; tenantId: string };

/** Resolve session and require an authenticated user with a tenant. */
export async function requireTenant(): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return {
    ok: true,
    ctx: { userId: session.user.id, tenantId: session.user.tenantId },
  };
}
