// The phone's dictionary: the web dictionary minus the namespaces only the
// marketing site renders (hero, stats, showcase, how, pricing, faq, cta, nav,
// meta, and the marketing pages other than privacy/terms/contact).
//
// One list drives two consumers, and they must agree:
//  - this module picks the namespaces at import time, so `@matgary/i18n/mobile`
//    is a correct, typed subset wherever it runs (node tests included);
//  - `apps/mobile/metro.i18n.js` applies the same list to `ar.json` /
//    `en.json` for non-dev bundles, which is what actually keeps the dropped bytes
//    out of the Hermes bundle — a JSON module cannot be tree-shaken, and four
//    screens still read `dictionaries[...]` from the root entry.
//
// The list lives twice on purpose: here as a `const` tuple, so `MobileDictionary`
// is derived from it and cannot drift (a typo is a compile error in `Pick`), and
// in ./mobile-namespaces.json for the CommonJS Metro helper, which cannot import
// this module. packages/i18n/test/mobile.test.ts pins the two copies equal.
//
// Adding a namespace the app starts using: append it to BOTH lists and run
// `node --test --experimental-strip-types packages/i18n/test/`.
import ar_ from "./ar.json";
import en_ from "./en.json";
import type { Dictionary, Locale } from "./index";

export const MOBILE_NAMESPACES = [
  "app",
  "auth",
  "common",
  "mobile",
  "footer",
  "features",
  "marketing.privacy",
  "marketing.terms",
  "marketing.contact",
] as const;

type Namespace = (typeof MOBILE_NAMESPACES)[number];
type Full = typeof ar_;
/** Whole top-level namespaces ("app"), i.e. entries without a dot. */
type TopLevel = Exclude<Namespace, `${string}.${string}`>;
/** The `x` of every `"<parent>.x"` entry; distributes over the union. */
type TailOf<S, P extends string> = S extends `${P}.${infer T}` ? T : never;
export type MobileDictionary = Pick<Full, TopLevel> & {
  marketing: Pick<Full["marketing"], TailOf<Namespace, "marketing">>;
};

/**
 * Keep only the given dotted namespaces of a nested dictionary. "marketing.privacy"
 * keeps that sub-tree and nothing else under "marketing". Pure; used by the
 * Metro transformer too (same algorithm, kept in sync by the unit test).
 */
export function pickNamespaces<T extends Record<string, unknown>>(dict: T, paths: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const segs = p.split(".");
    let src: unknown = dict;
    let dst = out;
    for (let i = 0; i < segs.length; i++) {
      if (!src || typeof src !== "object" || !(segs[i] in (src as object))) break;
      const value = (src as Record<string, unknown>)[segs[i]];
      if (i === segs.length - 1) {
        dst[segs[i]] = value;
      } else {
        dst = (dst[segs[i]] ??= {}) as Record<string, unknown>;
        src = value;
      }
    }
  }
  return out as Partial<T>;
}

export const ar = pickNamespaces(ar_, MOBILE_NAMESPACES) as MobileDictionary;
export const en = pickNamespaces(en_ as Full, MOBILE_NAMESPACES) as MobileDictionary;

/** Same shape as the root `dictionaries`, for callers that switch on locale. */
export const mobileDictionaries: Record<Locale, MobileDictionary> = { ar, en };

/** `lookup()` takes the full type; the subset is structurally a prefix of it. */
export const asDictionary = (d: MobileDictionary): Dictionary => d as unknown as Dictionary;
