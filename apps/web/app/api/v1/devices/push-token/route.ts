import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/lib/db";
import { pushTokens } from "@/lib/db/schema";
import { requireTenant } from "@/lib/api/auth-helpers";
import { EXPO_TOKEN_RE } from "@/lib/push/expo-push";
import { registerPushToken } from "@/lib/push/register";

// Expo push token registry (doc 06 §8.3, §8.5).
//
// POST   — register (or refresh) the caller's token. Idempotent: the same
//          token twice just bumps `last_seen_at`. If the token already exists
//          under ANOTHER user (shared tablet, staff signed out, owner signed
//          in) the row is re-owned by the caller, because an Expo token
//          identifies a physical install and the previous user no longer
//          holds it. The write itself lives in lib/push/register.ts.
// DELETE — stop sending to one token. Idempotent and blind: unknown token,
//          already-disabled token and a real disable all return 200.
//
// Both require a live bearer — a token registered pre-auth belongs to no one.
// Contract is shared with the mobile app: do not change the shapes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const registerSchema = z.object({
  token: z.string().max(200).regex(EXPO_TOKEN_RE, "Not an Expo push token"),
  platform: z.enum(["ios", "android"]),
  deviceName: z.string().trim().min(1).max(120).optional(),
});

const deleteSchema = z.object({
  token: z.string().max(200).regex(EXPO_TOKEN_RE, "Not an Expo push token"),
});

export async function POST(req: Request) {
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;

  const parsed = registerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_BODY", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { tenantId, userId } = auth.ctx;
  await registerPushToken(tenantId, userId, parsed.data);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;

  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const { tenantId, userId } = auth.ctx;

  // Scoped to the caller: you can only silence a token you own.
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(pushTokens)
      .set({ disabledAt: new Date() })
      .where(
        and(
          eq(pushTokens.tenantId, tenantId),
          eq(pushTokens.userId, userId),
          eq(pushTokens.expoToken, parsed.data.token),
          isNull(pushTokens.disabledAt),
        ),
      );
  });

  return NextResponse.json({ ok: true });
}
