import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { consumeResetToken } from "@/lib/repo/password-reset";
import { rateLimit } from "@/lib/ratelimit";

const schema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(8).max(128),
});

// Defence against token-stuffing: 20 attempts/hour/IP. A legitimate user
// only hits this once.
const RESET_LIMIT = 20;
const RESET_WINDOW_SEC = 60 * 60;

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip")?.trim() ??
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "بيانات غير صحيحة" },
      { status: 400 },
    );
  }

  const ip = await clientIp();
  const rl = await rateLimit("pwd.reset.token", ip, {
    limit: RESET_LIMIT,
    windowSec: RESET_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "محاولات كثيرة. حاول لاحقاً." },
      { status: 429 },
    );
  }

  const result = await consumeResetToken(parsed.data.token, parsed.data.newPassword);
  if (!result.ok) {
    const map = {
      invalid_token: "الرابط غير صالح أو منتهي الصلاحية. اطلب رابطاً جديداً.",
      weak_password: "كلمة المرور لازم تكون 8 أحرف على الأقل.",
      internal: "حدث خطأ. حاول مرة أخرى بعد قليل.",
    } as const;
    return NextResponse.json({ error: map[result.reason] }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
