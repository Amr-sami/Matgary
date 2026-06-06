import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { issueResetToken } from "@/lib/repo/password-reset";
import { sendMail } from "@/lib/mailer";
import { rateLimit } from "@/lib/ratelimit";
import { buildPasswordResetEmail } from "@/lib/mail/password-reset";

const schema = z.object({
  email: z.string().email().max(200),
});

// Rate limit per IP — public endpoint, gets harvested otherwise. The same
// email can hammer this from one IP a few times legitimately (browser back
// button, retry).
const FORGOT_LIMIT = 5;
const FORGOT_WINDOW_SEC = 60 * 60;

// Per-email throttle — belt + suspenders on top of the IP one. Prevents a
// rotating-IP attacker from using this endpoint as a presence oracle by
// hammering a single email. Identifier is the SHA-256 of the lowercased
// email so the raw address never lands in Redis. Consumed unconditionally
// (known + unknown emails) so attempt count doesn't leak existence.
const FORGOT_EMAIL_LIMIT = 3;
const FORGOT_EMAIL_WINDOW_SEC = 60 * 60;

function hashEmail(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex");
}

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
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  const ip = await clientIp();
  const ipRl = await rateLimit("pwd.forgot", ip, {
    limit: FORGOT_LIMIT,
    windowSec: FORGOT_WINDOW_SEC,
  });
  if (!ipRl.ok) {
    return NextResponse.json({ ok: true });
  }

  const email = parsed.data.email.trim().toLowerCase();

  // Per-email bucket runs BEFORE the DB lookup so timing is identical for
  // known and unknown emails.
  const emailRl = await rateLimit("pwd.forgot.email", hashEmail(email), {
    limit: FORGOT_EMAIL_LIMIT,
    windowSec: FORGOT_EMAIL_WINDOW_SEC,
  });
  if (!emailRl.ok) {
    return NextResponse.json({ ok: true });
  }

  const issued = await issueResetToken(email);

  if (issued.emailExists) {
    // Use the user's stored locale (set at signup) to pick the email
    // template AND the locale prefix on the link. Falls back to "ar"
    // for legacy rows where locale is missing (the column default).
    const origin = req.nextUrl.origin;
    const link =
      `${origin}/${issued.locale}/reset-password` +
      `?token=${encodeURIComponent(issued.raw)}`;
    const tpl = buildPasswordResetEmail(issued.locale, { link });
    await sendMail({
      to: email,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });
  }

  // Always 200 — never reveal whether the email exists. Attackers can't
  // distinguish "email registered" from "email not registered".
  return NextResponse.json({ ok: true });
}
