import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";
import { createDemoClone, findDemoTemplate } from "@/lib/demo/clone-tenant";
import { mintNativeSession } from "@/lib/api/native-session";
import { clientIp } from "@/lib/request-ip";

// The trial store, for a native client.
//
// The web's startDemoSession() is a Next server action: it builds the throwaway
// user and the tenant clone, then calls signIn() to set the cookie. React
// Native cannot invoke a server action, and until this route existed the
// "تصفح المتجر التجريبي" button on the login screen had nothing to call.
//
// Same limits, same template, same clone. Only the last step differs: instead
// of a cookie, the session is minted as bearer tokens through the helper the
// password login uses, so a trial visitor gets exactly the session shape a real
// customer does.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_LIMIT = 10;
const DEMO_WINDOW_SEC = 60 * 60;

const bodySchema = z
  .object({
    locale: z.enum(["ar", "en"]).optional(),
    deviceName: z.string().max(120).optional(),
    platform: z.enum(["ios", "android", "web"]).optional(),
    appVersion: z.string().max(40).optional(),
    installId: z.string().max(120).optional(),
  })
  .optional();

export async function POST(req: Request) {
  const h = await headers();

  const rl = await rateLimit("demo.start", clientIp(h), {
    limit: DEMO_LIMIT,
    windowSec: DEMO_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await req.text();
    body = bodySchema.parse(raw ? JSON.parse(raw) : undefined);
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const locale = body?.locale ?? "ar";

  const template = await findDemoTemplate();
  if (!template) {
    return NextResponse.json({ error: "TEMPLATE_MISSING" }, { status: 503 });
  }

  // Ephemeral throwaway user. The password is hashed and immediately
  // discarded: nothing ever signs in with it again, the bearer session is the
  // only credential this visitor holds.
  const token = randomBytes(16).toString("hex");
  const email = `demo-${token}@matgary.demo`;
  const passwordHash = await bcrypt.hash(randomBytes(24).toString("base64url"), 12);
  const userId = randomUUID();
  const name = "زائر التجربة";

  try {
    await db.insert(users).values({ id: userId, email, name, passwordHash, locale });
    await createDemoClone({ templateId: template.id, ownerUserId: userId, locale });
  } catch (err) {
    console.error("[demo] native start failed:", err);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }

  const session = await mintNativeSession(
    { id: userId, email, name },
    {
      deviceName: body?.deviceName,
      platform: body?.platform,
      appVersion: body?.appVersion,
      installId: body?.installId,
    },
  );
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: 500 });
  }
  return NextResponse.json({ ...session.body, demo: true }, { status: 201 });
}
