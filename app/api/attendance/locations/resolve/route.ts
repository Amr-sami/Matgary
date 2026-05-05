import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";

const SHORTLINK_HOSTS = ["maps.app.goo.gl", "goo.gl"];

const bodySchema = z.object({
  url: z.string().url().max(500),
});

/**
 * Resolve a Google Maps short link (maps.app.goo.gl/xxxx) into the long URL
 * that contains the actual coordinates. The client then parses lat/lng out
 * of the resolved URL.
 *
 * We don't return parsed coords here — the same client-side parser handles
 * both the short-link-resolved URL and any long URL the user pastes directly.
 */
export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  const url = parsed.data.url;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return NextResponse.json({ error: "رابط غير صالح" }, { status: 400 });
  }
  if (!SHORTLINK_HOSTS.includes(host)) {
    // Not a short link — caller should parse it directly.
    return NextResponse.json({ resolvedUrl: url });
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      // Some Google CDN edges 403 a default-UA fetch; pretend to be a browser.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
      },
      // 5-second timeout via AbortSignal (Node 18+).
      signal: AbortSignal.timeout(5000),
    });

    let resolvedUrl = res.url;

    // Some short links redirect into a `consent.google.com` interstitial whose
    // continue= param holds the real URL. Unwrap it once.
    try {
      const parsed = new URL(resolvedUrl);
      const cont = parsed.searchParams.get("continue");
      if (cont && /google\.com\/maps/.test(cont)) {
        resolvedUrl = cont;
      }
    } catch {
      // ignore — we'll just return whatever we have
    }

    // Last-ditch: if response.url didn't change but the body has the long URL
    // (some servers return an HTML page that does a meta-refresh / JS redirect),
    // try to extract it from the body.
    if (resolvedUrl === url) {
      try {
        const text = await res.text();
        const m = text.match(/https?:\/\/(?:www\.)?google\.com\/maps[^"'\s<>]+/);
        if (m) resolvedUrl = m[0];
      } catch {
        // ignore
      }
    }

    return NextResponse.json({ resolvedUrl });
  } catch {
    return NextResponse.json(
      { error: "تعذر الوصول للرابط — جرّب لصق الإحداثيات مباشرة" },
      { status: 502 },
    );
  }
}
