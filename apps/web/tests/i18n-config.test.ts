import { describe, expect, it } from "vitest";
import {
  isLocale,
  dirOf,
  defaultLocale,
  locales,
  LOCALE_COOKIE,
} from "@/lib/i18n/config";
import { pathLocale } from "@/lib/i18n/detect";

describe("i18n config — locale guards", () => {
  it("accepts the two locales we ship", () => {
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("en")).toBe(true);
  });

  it("rejects anything else (no silent fallthrough to default)", () => {
    expect(isLocale("fr")).toBe(false);
    expect(isLocale("AR")).toBe(false); // case-sensitive on purpose
    expect(isLocale("")).toBe(false);
    expect(isLocale("ar-EG")).toBe(false);
  });

  it("dirOf is rtl for Arabic, ltr for English", () => {
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
  });

  it("default locale is Arabic and is in the locales tuple", () => {
    expect(defaultLocale).toBe("ar");
    expect(locales).toContain(defaultLocale);
  });

  it("locale cookie name is stable (middleware + switcher agree)", () => {
    // Lock the cookie name down — changing this silently would log every
    // returning user out of their language preference on the next deploy.
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });
});

describe("pathLocale — first segment extraction", () => {
  it("returns the locale when the first segment is one", () => {
    expect(pathLocale("/ar/welcome")).toBe("ar");
    expect(pathLocale("/en/login")).toBe("en");
    expect(pathLocale("/ar")).toBe("ar");
    expect(pathLocale("/en")).toBe("en");
  });

  it("returns null when the first segment isn't a locale", () => {
    expect(pathLocale("/dashboard")).toBeNull();
    expect(pathLocale("/api/categories")).toBeNull();
    expect(pathLocale("/")).toBeNull();
    expect(pathLocale("")).toBeNull();
  });

  it("doesn't confuse a longer segment that starts with a locale code", () => {
    // "argentina" starts with "ar" but isn't a locale.
    expect(pathLocale("/argentina")).toBeNull();
    expect(pathLocale("/english")).toBeNull();
  });
});
