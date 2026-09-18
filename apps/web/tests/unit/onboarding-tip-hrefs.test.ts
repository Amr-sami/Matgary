/**
 * HANDOFF §8 item 13 — the onboarding review step renders one tip list per
 * preset (`auth.onboarding.step2.tips[preset]`), and the presets order their
 * tips differently. A single shared TIP_HREFS array sent the blank preset's
 * "Settings" link to /inventory/new. This locks each tip's link text to the
 * route it lands on, in both dictionaries.
 */
import { describe, expect, it } from "vitest";

import ar from "../../../../packages/i18n/src/ar.json";
import en from "../../../../packages/i18n/src/en.json";
import {
  TIP_HREFS,
  type OnboardingPreset,
} from "../../app/[lang]/(auth)/onboarding/tip-hrefs";

type Tip = { before: string; link?: string; after: string };

// What each link label promises, per language. A tip whose label isn't in
// this map fails the test on purpose — add the route, don't loosen the map.
const LABEL_TO_ROUTE: Record<string, Record<string, string>> = {
  en: { "Add product": "/inventory/new", Sales: "/sales", Settings: "/settings" },
  ar: { "إضافة منتج": "/inventory/new", المبيعات: "/sales", الإعدادات: "/settings" },
};

const PRESETS: OnboardingPreset[] = ["cornerstore", "blank"];

describe("onboarding TIP_HREFS", () => {
  for (const [lang, dict] of [
    ["en", en],
    ["ar", ar],
  ] as const) {
    for (const preset of PRESETS) {
      it(`${lang}/${preset}: every tip link lands where its label says`, () => {
        const tips = dict.auth.onboarding.step2.tips[preset] as Tip[];
        expect(tips.length).toBe(TIP_HREFS[preset].length);
        tips.forEach((tip, i) => {
          expect(tip.link, `tip #${i} has a link token`).toBeTruthy();
          const expected = LABEL_TO_ROUTE[lang][tip.link!];
          expect(expected, `route known for label "${tip.link}"`).toBeDefined();
          expect(TIP_HREFS[preset][i]).toBe(expected);
        });
      });
    }
  }

  it("the presets do not share one array", () => {
    expect(TIP_HREFS.cornerstore).not.toEqual(TIP_HREFS.blank);
  });
});
