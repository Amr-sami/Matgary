import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";

import { rateLimit } from "@/lib/ratelimit";
import { createAccount } from "@/lib/auth/create-account";
import { mintNativeSession } from "@/lib/api/native-session";

// Signup, for a native client.
//
// The web's signupAction is a server action, which React Native cannot call.
// The account creation itself lives in lib/auth/create-account.ts and is
// shared with that action byte-for-byte; this route adds only the transport
// (JSON in, bearer tokens out) around it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_SEC = 60 * 60;

const bodySchema = z.object({
  email: z.unknown(),
  password: z.unknown(),
  storeName: z.unknown(),
  storeHandle: z.unknown(),
  locale: z.enum(["ar", "en"]).optional(),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().max(40).optional(),
  installId: z.string().max(120).optional(),
});

function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() ?? "unknown";
}

/** Field-level codes map to 422 so a form can highlight the input; the rest are 409/429. */
function statusFor(code: string): number {
  switch (code) {
    case "EMAIL_TAKEN":
    case "HANDLE_TAKEN":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "INTERNAL":
    case "AUTO_LOGIN_FAILED":
      return 500;
    default:
      return 422;
  }
}

export async function POST(req: Request) {
  const h = await headers();
  const rl = await rateLimit("signup.ip", clientIp(h), {
    limit: SIGNUP_LIMIT,
    windowSec: SIGNUP_WINDOW_SEC,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  // createAccount validates the four account fields itself with the same zod
  // schema the web uses, so a bad email or weak password comes back as a
  // field-coded error rather than a generic 400.
  const created = await createAccount(
    {
      email: body.email,
      password: body.password,
      storeName: body.storeName,
      storeHandle: body.storeHandle,
    },
    body.locale ?? "ar",
  );
  if (!created.ok) {
    return NextResponse.json(
      { error: created.code, field: created.field ?? null },
      { status: statusFor(created.code) },
    );
  }

  const session = await mintNativeSession(
    { id: created.userId, email: created.email, name: null },
    {
      deviceName: body.deviceName,
      platform: body.platform,
      appVersion: body.appVersion,
      installId: body.installId,
    },
  );
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: 500 });
  }
  return NextResponse.json(session.body, { status: 201 });
}
