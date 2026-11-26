// Where each step-2 (review) onboarding tip's `link` token lands the user,
// per preset. The two presets list their tips in a different order
// (`auth.onboarding.step2.tips[preset]`: "blank" leads with Settings because
// the shop has no categories yet), so one shared array mismatched the blank
// preset's own tip text — HANDOFF §8 item 13. Logged-in app routes are
// unprefixed. Kept in its own module so tests can load it without pulling
// in the client component's next/* imports.

export type OnboardingPreset = "cornerstore" | "blank";

export const TIP_HREFS: Record<OnboardingPreset, readonly string[]> = {
  cornerstore: ["/inventory/new", "/sales", "/settings"],
  blank: ["/settings", "/inventory/new", "/sales"],
};
