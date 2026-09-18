import { Tabs } from "expo-router";

import { BottomNav } from "@/components/layout/BottomNav";
import { RouteErrorFallback } from "@/observability/sentry";

/**
 * Wraps every CHILD screen (not this layout) in the bilingual fallback, so a
 * render throw shows "something went wrong" + retry / back to home with the
 * tab bar still alive — instead of a dead white screen after the red box is
 * dismissed. Screen scope: the broken tab keeps its fallback until "try again".
 */
export const unstable_settings = { screenErrorBoundary: RouteErrorFallback };

/**
 * The boundary for THIS layout: the Tabs, BottomNav and nested layouts
 * (settings/_layout.tsx is a layout, not a screen, so the per-screen wrapper
 * above does not cover it). expo-router wraps this file's component in
 * `<Try catch={ErrorBoundary}>`; the fallback then replaces the Tabs, so it
 * is the layout-scope variant whose "back to home" also remounts them.
 */
export { LayoutErrorFallback as ErrorBoundary } from "@/observability/sentry";

/**
 * The tab bar is the web's MobileBottomNav, not a stock one: seven items with
 * Arabic labels under Phosphor glyphs and an accent underline on the active
 * tab, none of which survives the platform default.
 *
 * The first seven screens are the bar, in the order it reads right-to-left:
 * لوحة · المخزن · المبيعات · إضافة صنف · المشتريات · إحصائيات · المزيد.
 *
 * The rest are the More-sheet destinations. They are declared here so the
 * navigator knows them and `router.push("/customers")` resolves, but BottomNav
 * renders only its own seven, so they never appear as tabs.
 */
export default function AppLayout() {
  return (
    <Tabs
      tabBar={(props) => <BottomNav {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="inventory" />
      <Tabs.Screen name="sales" />
      <Tabs.Screen name="add-product" />
      <Tabs.Screen name="purchases" />
      <Tabs.Screen name="insights" />
      <Tabs.Screen name="more" />

      <Tabs.Screen name="tasks" />
      <Tabs.Screen name="customers" />
      <Tabs.Screen name="expenses" />
      <Tabs.Screen name="suppliers" />
      <Tabs.Screen name="returns" />
      <Tabs.Screen name="team" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="leave" />
      <Tabs.Screen name="whatsapp" />
      <Tabs.Screen name="settings" />
      <Tabs.Screen name="onboarding" />
      <Tabs.Screen name="billing" />
      <Tabs.Screen name="notifications" />
      <Tabs.Screen name="attendance" />
      <Tabs.Screen name="sync" />
    </Tabs>
  );
}
