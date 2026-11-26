// Digital collections — error copy lookup shared by the web dialogs and the
// settle modal (doc 15 spec 12 §4.6, §4.7). A server `error` code found in one
// of the tables (in order) gives that text; anything else the fallback. The
// server's raw `detail` is never shown.

import { CollectionsApiError } from "@/lib/api/collections";

export function errorCode(e: unknown): string | null {
  if (e instanceof CollectionsApiError) return e.code;
  return null;
}

export function errorCopy(
  code: string | null | undefined,
  tables: ReadonlyArray<Record<string, string> | undefined>,
  fallback: string,
): string {
  if (!code) return fallback;
  for (const t of tables) {
    const v = t?.[code];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}
