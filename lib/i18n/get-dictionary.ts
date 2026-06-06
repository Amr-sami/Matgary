import "server-only";
import type { Locale } from "./config";

const dictionaries = {
  ar: () => import("@/dictionaries/ar.json").then((m) => m.default),
  en: () => import("@/dictionaries/en.json").then((m) => m.default),
} as const;

export type Dictionary = Awaited<ReturnType<(typeof dictionaries)["ar"]>>;

export const getDictionary = (locale: Locale): Promise<Dictionary> =>
  dictionaries[locale]();
