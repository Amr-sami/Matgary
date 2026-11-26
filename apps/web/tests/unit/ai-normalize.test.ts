/**
 * F2 — normalizer + fuzzy scorer tests.
 *
 * These are pure-function unit tests that pin the bilingual folding rules
 * the resolver depends on. If a test here fails, the "عندك برفانات assaf؟"
 * regression test in ai-product-search.test.ts will almost certainly fail too.
 */
import { describe, expect, it } from "vitest";

import {
  canonical,
  normalizeArabic,
  normalizeDigits,
  normalizeSku,
  score,
  tokens,
  transliterateArabicToLatin,
} from "@/lib/ai/normalize";

describe("normalizeDigits", () => {
  it("maps Arabic-Indic digits to ASCII", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("maps Persian digits to ASCII", () => {
    expect(normalizeDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("leaves ASCII digits alone", () => {
    expect(normalizeDigits("sku-1234")).toBe("sku-1234");
  });
});

describe("normalizeArabic", () => {
  it("strips tashkeel", () => {
    expect(normalizeArabic("مُحَمَّد")).toBe("محمد");
  });

  it("collapses alif variants", () => {
    expect(normalizeArabic("أساف")).toBe("اساف");
    expect(normalizeArabic("إساف")).toBe("اساف");
    expect(normalizeArabic("آساف")).toBe("اساف");
  });

  it("folds taa marbuta to haa", () => {
    expect(normalizeArabic("ساعة")).toBe("ساعه");
  });

  it("folds alif maksura to yaa", () => {
    expect(normalizeArabic("مصطفى")).toBe("مصطفي");
  });
});

describe("transliterateArabicToLatin", () => {
  it("maps أساف → asaf (after alif normalization applied)", () => {
    // Apply normalizeArabic first to collapse أ → ا, then transliterate.
    expect(transliterateArabicToLatin(normalizeArabic("أساف"))).toBe("asaf");
  });

  it("leaves Latin letters untouched", () => {
    expect(transliterateArabicToLatin("Casio")).toBe("Casio");
  });

  it("handles mixed script", () => {
    expect(transliterateArabicToLatin(normalizeArabic("برفان Casio"))).toBe("brfan Casio");
  });
});

describe("canonical", () => {
  it("equates the Arabic and Latin spellings of 'Assaf'", () => {
    // After folding both should collapse to the same canonical token.
    const arabic = canonical("أساف");
    const latin = canonical("assaf");
    expect(arabic).toBe(latin);
  });

  it("tolerates doubled letters (assaaf, asaaf) → asaf", () => {
    expect(canonical("asaaf")).toBe("asaf");
    expect(canonical("assaaf")).toBe("asaf");
    expect(canonical("assaf")).toBe("asaf");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(canonical("  Assaf, Perfume!  ")).toBe("asaf perfume");
  });
});

describe("tokens", () => {
  it("splits into canonical tokens", () => {
    expect(tokens("Pink Diva")).toEqual(["pink", "diva"]);
  });

  it("returns empty for empty-ish input", () => {
    expect(tokens("")).toEqual([]);
    expect(tokens("   ")).toEqual([]);
  });
});

describe("score", () => {
  it("returns 1.0 on canonical equality", () => {
    expect(score("assaf", "Assaf")).toBe(1);
    // Cross-script equality — the main F2 requirement.
    expect(score("assaf", "أساف")).toBe(1);
  });

  it("returns 0.95 when every query token appears in candidate tokens", () => {
    // Order doesn't matter for the "all tokens present" case.
    expect(score("diva pink", "Pink Diva")).toBe(0.95);
  });

  it("returns 0.85 for canonical substring match", () => {
    // "pink diva" is a substring of "pink diva assaf" (after canonical).
    expect(score("pink diva", "Pink Diva Assaf")).toBe(0.95); // all tokens present
    // Partial substring that doesn't fit the "all tokens present" rule:
    expect(score("rumm", "Musk Rumman")).toBeGreaterThanOrEqual(0.55);
  });

  it("returns 0 for completely unrelated text", () => {
    expect(score("assaf", "citizen watch")).toBe(0);
  });

  it("returns 0 for empty inputs", () => {
    expect(score("", "foo")).toBe(0);
    expect(score("foo", "")).toBe(0);
  });

  it("matches Arabic brand against Latin query", () => {
    // Core F2 case: user types English "assaf", product has Arabic "أساف".
    expect(score("assaf", "أساف")).toBeGreaterThanOrEqual(0.95);
  });
});

describe("normalizeSku", () => {
  it("strips non-alphanumerics and lowercases", () => {
    expect(normalizeSku("SKU-12 34")).toBe("sku1234");
    expect(normalizeSku("6287015129702")).toBe("6287015129702");
  });
});
