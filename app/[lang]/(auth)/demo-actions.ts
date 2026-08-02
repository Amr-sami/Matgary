"use server";

import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { headers } from "next/headers";

import { signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { rateLimit } from "@/lib/ratelimit";
import { createDemoClone, findDemoTemplate } from "@/lib/demo/clone-tenant";
import { defaultLocale, isLocale, type Locale } from "@/lib/i18n/config";

// Generous cap on tenant churn from a single IP. The clone+sign-in path is
// ~300-500ms of DB work, so anyone scripting against this is also doing real
// damage. 10/h is well above the "click around for a minute" load.
const DEMO_LIMIT = 10;
const DEMO_WINDOW_SEC = 60 * 60;

async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() ?? "unknown";
}

async function activeLocale(): Promise<Locale> {
  const h = await headers();
  const raw = h.get("x-locale");
  return raw && isLocale(raw) ? raw : defaultLocale;
}

export type DemoLoginResult =
  | { ok: true; redirectTo: string }
  | { ok: false; code: "RATE_LIMITED" | "TEMPLATE_MISSING" | "INTERNAL" };

/** Spin up an ephemeral tenant cloned from the demo template and sign the
 *  visitor in to it. Called from the "تصفح المتجر التجريبي" button. */
export async function startDemoSession(): Promise<DemoLoginResult> {
  const ip = await clientIp();
  const locale = await activeLocale();

  const rl = await rateLimit("demo.start", ip, {
    limit: DEMO_LIMIT,
    windowSec: DEMO_WINDOW_SEC,
  });
  if (!rl.ok) return { ok: false, code: "RATE_LIMITED" };

  const template = await findDemoTemplate();
  if (!template) {
    console.error("[demo] no template tenant — run `pnpm db:seed:demo`");
    return { ok: false, code: "TEMPLATE_MISSING" };
  }

  // Ephemeral throwaway user — email never collides because the random
  // token is 16 bytes / 32 hex chars. Password is hashed but discarded:
  // we sign in once and never reuse the credentials.
  const token = randomBytes(16).toString("hex");
  const email = `demo-${token}@matgary.demo`;
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomUUID();

  try {
    await db.insert(users).values({
      id: userId,
      email,
      name: "زائر التجربة",
      passwordHash,
      locale,
    });

    await createDemoClone({
      templateId: template.id,
      ownerUserId: userId,
      locale,
    });

    await signIn("credentials", { email, password, redirect: false });
  } catch (err) {
    console.error("[demo] start failed:", err);
    return { ok: false, code: "INTERNAL" };
  }

  // The middleware reads the locale cookie + JWT to render the user's
  // language. Redirect to "/" so app/page.tsx renders — there's no
  // /app/[lang]/page.tsx route.
  return { ok: true, redirectTo: "/" };
}
