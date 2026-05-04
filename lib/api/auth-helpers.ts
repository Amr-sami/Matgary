import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { Permission } from "@/lib/permissions";
import { can } from "@/lib/permissions";

export type AuthedContext = {
  userId: string;
  tenantId: string;
  role: string | null;
  permissions: Permission[];
};

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
    ctx: {
      userId: session.user.id,
      tenantId: session.user.tenantId,
      role: session.user.role,
      permissions: (session.user.permissions ?? []) as Permission[],
    },
  };
}

/**
 * Require a logged-in user with at least one of the given permissions.
 * Owner role bypasses the check (owns everything in their tenant).
 */
export async function requirePermission(perm: Permission): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireTenant();
  if (!auth.ok) return auth;
  if (!can(auth.ctx, perm)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return auth;
}
