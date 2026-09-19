// The 3,072-key dictionaries, shared by both clients.
//
// Moved here from apps/web/dictionaries with `git mv` so the phone and the
// web cannot drift in wording: one file, two consumers. The web loads them
// lazily by locale (lib/i18n/get-dictionary.ts); the phone bundles both and
// picks at boot.
import ar from "./ar.json";
import en from "./en.json";

export type Locale = "ar" | "en";
export const locales: readonly Locale[] = ["ar", "en"] as const;
export const defaultLocale: Locale = "ar";

/** Shape is the Arabic file's; English mirrors it key-for-key (verified: 3,072 each). */
export type Dictionary = typeof ar;

export const dictionaries: Record<Locale, Dictionary> = { ar, en: en as Dictionary };

/**
 * "auth.login.title" -> the string, or the path itself when missing so a gap
 * is visible, not blank.
 *
 * Some dictionary keys contain dots themselves — the notification event
 * types are stored as "sale.created", "inventory.low_stock" — so a naive
 * split on "." walks into the wrong subtree. At each level this tries the
 * longest run of remaining segments that exists as a single key first.
 */
export function lookup(dict: Dictionary, path: string): string {
  const parts = path.split(".");
  let node: unknown = dict;
  let i = 0;
  while (i < parts.length) {
    if (!node || typeof node !== "object") return path;
    const obj = node as Record<string, unknown>;
    let matched = false;
    for (let len = parts.length - i; len >= 1; len--) {
      const key = parts.slice(i, i + len).join(".");
      if (key in obj) {
        node = obj[key];
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) return path;
  }
  return typeof node === "string" ? node : path;
}

/** "{n} منتج" + { n: 3 } -> "3 منتج". Same brace syntax the web's dictionaries use. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
