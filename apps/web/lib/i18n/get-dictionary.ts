import "server-only";
import type { Locale } from "./config";

const dictionaries = {
  ar: () => import("@matgary/i18n/ar").then((m) => m.default),
  en: () => import("@matgary/i18n/en").then((m) => m.default),
} as const;

export type Dictionary = Awaited<ReturnType<(typeof dictionaries)["ar"]>>;

export const getDictionary = (locale: Locale): Promise<Dictionary> =>
  dictionaries[locale]();
