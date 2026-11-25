/**
 * F7 — Server-side AI i18n dictionary tests.
 *
 * Checks:
 *   • Every well-known key resolves to a non-empty, non-key string for each
 *     supported locale.
 *   • Missing locale → English fallback (per Part 19).
 *   • Missing key → raw key returned + a WARN logged (never empty / never throw).
 *   • Interpolation of {var} placeholders works across all locales.
 */
import { describe, expect, it, vi } from "vitest";

import { AI_MESSAGES, tr } from "@/lib/ai/i18n";
import { LOCALES } from "@/lib/ai/language";

describe("tr — coverage across 5 locales", () => {
  it("every key in AI_MESSAGES resolves non-empty for every supported locale", () => {
    for (const key of Object.keys(AI_MESSAGES)) {
      for (const loc of LOCALES) {
        const s = tr(key, loc);
        expect(s, `${key} / ${loc}`).toBeTruthy();
        // When a locale is missing an entry we fall back to EN — the returned
        // value must NEVER equal the raw key for a known key.
        expect(s, `${key} / ${loc} → raw key`).not.toBe(key);
      }
    }
  });

  it("Arabic entries use Arabic script where present", () => {
    // A random sample — the title keys are predictable.
    const arSample = tr("salesSummary.title", "ar");
    expect(/[؀-ۿ]/.test(arSample)).toBe(true);
  });

  it("Portuguese / French / Spanish titles differ from each other and from English", () => {
    const pt = tr("inventorySummary.title", "pt");
    const fr = tr("inventorySummary.title", "fr");
    const es = tr("inventorySummary.title", "es");
    const en = tr("inventorySummary.title", "en");
    expect(new Set([pt, fr, es, en]).size).toBeGreaterThanOrEqual(3);
  });
});

describe("tr — fallback policy", () => {
  it("missing key logs a warning and returns the raw key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = tr("this.key.does.not.exist", "en");
    expect(s).toBe("this.key.does.not.exist");
    expect(warn).toHaveBeenCalledWith(
      "[ai/i18n] missing key",
      expect.objectContaining({ key: "this.key.does.not.exist" }),
    );
    warn.mockRestore();
  });

  // Note: EVERY shipped key has an English entry by construction, so the
  // "locale-missing + en-missing" path is unreachable for shipped keys.
  // We assert it indirectly by relying on the first test above (every key
  // resolves non-empty).
});

describe("tr — interpolation", () => {
  it("replaces {var} in every locale", () => {
    for (const loc of LOCALES) {
      const s = tr("write.price.summary", loc, { before: "2,200", after: "2,500" });
      expect(s.includes("2,200")).toBe(true);
      expect(s.includes("2,500")).toBe(true);
      expect(s.includes("{before}")).toBe(false);
      expect(s.includes("{after}")).toBe(false);
    }
  });

  it("keeps unknown {var} tokens as-is instead of emptying them", () => {
    const s = tr("write.price.summary", "en", {});
    // `before` and `after` not supplied → placeholders survive as `{before}`.
    expect(s.includes("{before}")).toBe(true);
    expect(s.includes("{after}")).toBe(true);
  });
});
