import { Stack } from "expo-router";

import { useLocale } from "@/i18n";
import { directionStyle } from "@/theme/rtl";
import { colors } from "@/theme/tokens";

/**
 * The Collections inbox and its detail screens are one STACK (as settings/
 * is), not sibling tabs.
 *
 * Without this layout expo-router hoisted `collections/[id]` and
 * `collections/credit/[id]` into the (app) Tabs navigator beside the inbox.
 * `router.push("/collections/<id>")` then switched TABS, and the detail's
 * "‹ Collections" (useGoBack → router.back()) went back the Tabs way —
 * backBehavior "firstRoute" — to Home, never to the inbox it came from
 * (doc 15 T1 F3: inbox opened by matgary://collections?stale=1 → detail →
 * confirm → back → Home). As a stack the push is a real push, the back link,
 * the hardware back and the swipe pop to the inbox with its tab and "late
 * only" filter as they were, and the route names the Tabs see stay
 * `collections`.
 *
 * `initialRouteName: "index"` puts the inbox UNDER a detail that is opened
 * directly — a push-notification tap, matgary://collections/<id>, a link
 * from a sale — so its back link still lands on the inbox it names.
 *
 * Header off and the direction re-stated for the nested native stack: see
 * settings/_layout.tsx.
 */
export const unstable_settings = { initialRouteName: "index" };

export default function CollectionsLayout() {
  const locale = useLocale((s) => s.locale);
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg, ...directionStyle(locale === "ar") },
      }}
    />
  );
}
