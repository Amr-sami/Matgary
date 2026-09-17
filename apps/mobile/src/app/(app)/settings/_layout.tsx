import { Stack } from "expo-router";

import { RTL } from "@/theme/rtl";
import { colors } from "@/theme/tokens";

/**
 * Settings is the one tab that is a STACK rather than a single screen.
 *
 * Declaring this layout is what keeps the route name the tab navigator sees at
 * `settings` — without it expo-router hoists `settings/index`, `settings/branches`
 * … straight into the (app) Tabs navigator, which would have forced a rename in
 * `(app)/_layout.tsx` and turned every sub-page into a sibling tab with no back
 * stack. With it, `router.push("/settings/branches")` is a real push, the system
 * back gesture / hardware button pops it, and the bottom bar stays mounted the
 * whole time — which is exactly what the captures show.
 *
 * Header is off because every screen renders its own Arabic title through
 * `Screen`; the native header would place its back chevron by `I18nManager`,
 * which is LTR under Expo Go (see theme/rtl.ts) and would point the wrong way.
 */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg, ...RTL },
      }}
    />
  );
}
