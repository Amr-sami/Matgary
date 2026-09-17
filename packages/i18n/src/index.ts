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

/** "auth.login.title" -> the string, or the path itself when missing so a gap is visible, not blank. */
export function lookup(dict: Dictionary, path: string): string {
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (node && typeof node === "object" && part in (node as object)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return path;
    }
  }
  return typeof node === "string" ? node : path;
}

/** "{n} منتج" + { n: 3 } -> "3 منتج". Same brace syntax the web's dictionaries use. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
