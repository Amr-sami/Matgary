import { NextResponse } from "next/server";
import { z } from "zod";

import { requireTenant } from "@/lib/api/auth-helpers";
import { defaultLocale } from "@/lib/i18n/config";
import {
  completeOnboarding,
  parseOnboardingInput,
  type OnboardingErrorCode,
} from "@/lib/onboarding/complete";

// Onboarding completion for a native client.
//
// The web wizard finishes through the completeOnboardingAction Server Action,
// which React Native cannot invoke. This route is the same operation on the
// bearer plane: it validates the JSON envelope and hands the typed input to
// lib/onboarding/complete.ts — the one implementation both transports share —
// so the "cornerstore" preset seeds the catalog from the app exactly as it
// does from the browser.
//
// Any signed-in member of the tenant may complete it, matching the action
// (there is no owner check there either; the wizard is a soft gate).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const localeSchema = z.enum(["ar", "en"]).optional();

const STATUS: Record<OnboardingErrorCode, number> = {
  UNAUTHORIZED: 401,
  SHOP_NAME_REQUIRED: 400,
  INVALID_PHONE: 400,
  INVALID_INPUT: 400,
  PRIMARY_BRANCH_MISSING: 409,
  INTERNAL: 500,
};

export async function POST(req: Request) {
  const auth = await requireTenant();
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  }

  // Locale is envelope-only; the onboarding fields go through the shared
  // parser so the error codes match the web action's.
  const locale = localeSchema.safeParse((raw as { locale?: unknown } | null)?.locale);
  const parsed = parseOnboardingInput(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.code }, { status: STATUS[parsed.code] });
  }

  const result = await completeOnboarding(
    auth.ctx.tenantId,
    auth.ctx.userId,
    parsed.data,
    locale.success && locale.data ? locale.data : defaultLocale,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.code }, { status: STATUS[result.code] });
  }
  return NextResponse.json({ ok: true });
}
