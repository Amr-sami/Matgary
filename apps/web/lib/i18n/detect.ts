import type { NextRequest } from "next/server";
import { LOCALE_COOKIE, defaultLocale, isLocale, locales, type Locale } from "./config";

function pickFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, qStr] = part.trim().split(";q=");
      const q = qStr ? Number(qStr) : 1;
      return { tag: tag.toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}

export function detectLocale(req: NextRequest): Locale {
  const cookieValue = req.cookies.get(LOCALE_COOKIE)?.value;
  if (cookieValue && isLocale(cookieValue)) return cookieValue;
  const fromHeader = pickFromAcceptLanguage(req.headers.get("accept-language"));
  return fromHeader ?? defaultLocale;
}

export function pathLocale(pathname: string): Locale | null {
  const seg = pathname.split("/")[1];
  if (seg && isLocale(seg)) return seg;
  return null;
}

export { locales, defaultLocale, isLocale };
