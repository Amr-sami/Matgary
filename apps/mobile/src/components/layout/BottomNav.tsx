import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Animated, Image, Keyboard, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { ChartBarIcon as ChartBar } from "phosphor-react-native/src/icons/ChartBar";
import { GridFourIcon as GridFour } from "phosphor-react-native/src/icons/GridFour";
import { ListIcon as List } from "phosphor-react-native/src/icons/List";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { PlusSquareIcon as PlusSquare } from "phosphor-react-native/src/icons/PlusSquare";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";

import { api } from "@/api/client";
import { UNREAD_TASKS_KEY, badgeText, useBadges } from "@/stores/badges";
import { useSession } from "@/stores/session";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";
import { t } from "@/i18n";

// User-supplied cart-plus asset (apps/mobile/assets/images/add-shopping-cart.png,
// 2026-10-25). Monochrome glyph on transparent background — the FAB tints it to
// colors.onAccent at render time, so a theme change does not require re-exporting.
const ADD_SHOPPING_CART = require("@/assets/images/add-shopping-cart.png");

/**
 * Port of apps/web/components/layout/MobileBottomNav.tsx.
 *
 * Same destinations, same order, same Phosphor glyphs (the web aliases them
 * under lucide names in lib/icons.ts), and the same permission filtering — a
 * cashier gets a shorter bar rather than tabs that 403 on tap.
 *
 * Doc 05 argues for trimming this to five tabs on native. That is a design
 * change rather than a port, so it is deliberately NOT made here.
 */
type PhosphorIcon = ComponentType<{ size?: number; color?: string }>;

interface NavItem {
  /** expo-router route name under (app). */
  route: string;
  label: string;
  icon: PhosphorIcon;
  requires: string | null;
  /** Which badge count this tab carries, if any. Tasks lives under More. */
  badge?: "tasksUnread";
}

// The Sales slot in the ITEMS array holds the raised FAB's label + route; the
// `icon` field is unused for it (the SalesFab renders its own inline SVG) but
// kept to match the NavItem shape so filtering/active-state logic stays simple.
const ITEMS = (): NavItem[] => ([
  { route: "index", label: t("app.shell.primary.dashboardShort"), icon: GridFour, requires: "view_dashboard" },
  { route: "inventory", label: t("app.shell.primary.inventory"), icon: Package, requires: "view_inventory" },
  { route: "add-product", label: t("app.shell.primary.addProduct"), icon: PlusSquare, requires: "manage_inventory" },
  { route: "sales", label: t("app.shell.primary.sales"), icon: GridFour, requires: "view_sales" },
  { route: "purchases", label: t("app.shell.primary.purchases"), icon: Receipt, requires: "view_purchases" },
  { route: "insights", label: t("app.shell.primary.insights"), icon: ChartBar, requires: "view_insights" },
  { route: "more", label: t("app.shell.more"), icon: List, requires: null, badge: "tasksUnread" },
]);

// Raised-FAB and hump geometry. Keep them together — every one of these is
// consumed by both the SVG path builder and the layout math.
const FAB_SIZE = 56;              // circle diameter
const FAB_RADIUS = FAB_SIZE / 2;  // 28
const FAB_ICON = 26;              // SVG icon drawn inside the circle
const HUMP_GAP = 8;               // transparent gap between hump top and circle top
const HUMP_DEPTH = FAB_RADIUS + HUMP_GAP; // 36 — how high the hump peaks above the normal bar top
const HUMP_WIDTH = 140;           // ~2.5 × FAB_SIZE, matches the reference proportions
const HUMP_SHOULDER = 36;         // horizontal run of the S-curve on each side

/**
 * SVG `d` string for the bar background with a centered symmetric hump.
 *
 * Two cubic Béziers form the hump — one on each side — and reflect each other
 * across the vertical axis, which is what gives the "smooth S-curve shoulders"
 * the design calls for. All other edges are straight: the hump is the only
 * expressive bit, intentionally. If the sim is narrower than the hump, the
 * shoulders would clip; HUMP_WIDTH + 2×HUMP_SHOULDER = 212 fits every phone
 * ≥ ~360dp (smallest common iPhone SE is 320 — still fits).
 */
function buildBarPath(w: number, h: number, humpTopY: number, flatTopY: number): string {
  const cx = w / 2;
  const halfHump = HUMP_WIDTH / 2;
  const shoulderLeftX = cx - halfHump - HUMP_SHOULDER;
  const humpLeftX = cx - halfHump;
  const humpRightX = cx + halfHump;
  const shoulderRightX = cx + halfHump + HUMP_SHOULDER;
  // Control points chosen so the tangent at the shoulder is horizontal (meeting
  // the flat run smoothly) and the tangent at the apex is horizontal (symmetry).
  // Shifting them by 60% of the shoulder/half-hump produces the tight-S look of
  // the reference without a visible kink at the join point.
  const kLeftIn = shoulderLeftX + HUMP_SHOULDER * 0.6;
  const kLeftOut = humpLeftX + halfHump * 0.4;
  const kRightOut = humpRightX - halfHump * 0.4;
  const kRightIn = shoulderRightX - HUMP_SHOULDER * 0.6;
  return [
    `M 0 ${flatTopY}`,
    `L ${shoulderLeftX} ${flatTopY}`,
    `C ${kLeftIn} ${flatTopY}, ${kLeftOut} ${humpTopY}, ${cx} ${humpTopY}`,
    `C ${kRightOut} ${humpTopY}, ${kRightIn} ${flatTopY}, ${shoulderRightX} ${flatTopY}`,
    `L ${w} ${flatTopY}`,
    `L ${w} ${h}`,
    `L 0 ${h}`,
    "Z",
  ].join(" ");
}

/**
 * The user-supplied cart-plus glyph rendered on the FAB.
 *
 * The source PNG is monochrome black on a transparent background, so a single
 * `tintColor` repaints it to any theme token — this is why the file does not
 * need to be re-exported for dark mode or a rebrand. `resizeMode: "contain"`
 * preserves the icon's aspect ratio inside the square box; the ~26dp box is
 * chosen so the glyph reads at the same optical size as the other nav icons.
 */
function AddShoppingCartIcon({ size = FAB_ICON, color = colors.onAccent }: { size?: number; color?: string }) {
  return (
    <Image
      source={ADD_SHOPPING_CART}
      style={{ width: size, height: size, tintColor: color }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
    />
  );
}

/**
 * Structural props rather than `BottomTabBarProps`.
 *
 * expo-router bundles its own copy of @react-navigation/bottom-tabs, so the
 * hoisted types and the ones expo-router passes are two different nominal types
 * and never assignable to each other. This component only needs the active
 * route name and a way to navigate, so declaring exactly that sidesteps the
 * dual-package problem instead of casting around it.
 */
interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate: (name: string) => void };
}

export function BottomNav({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const permissions = useSession((s) => s.me?.permissions);
  // The password wall (doc 02 §1.1 row 25). SuspensionRouter lands the user
  // on /settings/change-password, but a bar that stays tappable lets them
  // open a tab whose queries all 403 PASSWORD_CHANGE_REQUIRED and flash the
  // dashboard shell until the router bounces them back. No bar, no leak; the
  // re-login after the change refreshes /me with the flag off and it returns.
  const passwordWall = useSession((s) => s.me?.user.mustChangePassword === true);
  const allowed = new Set(permissions ?? []);

  // Doc 02 §1.1 row 14 / web MobileBottomNav: the badge is the web's
  // useUnreadTaskCount — GET /api/tasks/unread-count, tasks assigned to me that
  // I have not seen, cleared by the tasks screen POSTing /api/tasks/seen. Not
  // the length of GET /api/tasks: a manager sees every task in the branch
  // there, and a permanent "9+" for other people's standing work says nothing.
  // requireTenant-only, so every signed-in user may ask.
  const unreadQuery = useQuery({
    queryKey: UNREAD_TASKS_KEY,
    queryFn: () => api.request<{ count: number }>("/api/tasks/unread-count"),
    enabled: permissions !== undefined,
    // Web parity (hooks/useUnreadTaskCount.ts): poll every minute while the
    // app is in the foreground. This bar is mounted for the whole session, so
    // its observer never remounts — without the interval the badge only moved
    // on app-foreground, reconnect, branch switch or the tasks screen's own
    // mutations, and a task assigned from the web stayed invisible.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const setTasksUnread = useBadges((s) => s.setTasksUnread);
  useEffect(() => {
    if (unreadQuery.data) setTasksUnread(unreadQuery.data.count);
  }, [unreadQuery.data, setTasksUnread]);
  // Sign-out unmounts the (app) group (root Stack.Protected) and this bar with
  // it. SnapshotRefresher clears the TanStack cache then, but not this store,
  // so drop the count here or the next account inherits it until its own
  // first fetch answers — indefinitely, if that fetch fails offline.
  useEffect(() => () => useBadges.getState().reset(), []);
  const tasksUnread = useBadges((s) => s.tasksUnread);

  // Android resizes the window for the keyboard (adjustResize) and this custom
  // bar does not get tabBarHideOnKeyboard, so it sat half-clipped above the
  // IME. iOS lets the keyboard cover it, which reads fine.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardShown(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const items = ITEMS();
  const visible = items.filter((i) => !i.requires || allowed.has(i.requires));

  // The Tabs navigator also holds the More-sheet destinations (settings,
  // customers, team, …) as hidden screens with no bar item, and the detail
  // routes without their own _layout (inventory/[id], sales/history,
  // team/[userId]) sit beside them as siblings. Matching the raw name against
  // the seven bar routes therefore lit no tab at all on any of those screens.
  // Resolve the route to its section instead: the first path segment when it
  // is a bar tab, otherwise More — the web MobileBottomNav marks More active
  // for every More-sheet path the same way, and the design ref shows المزيد
  // lit on Settings.
  const currentRoute = state.routes[state.index]?.name;
  const barRoutes = new Set(items.map((i) => i.route));
  const section = currentRoute?.split("/")[0] ?? "";
  const activeRoute = barRoutes.has(section) ? section : "more";

  // Full-screen experiences that must own the whole viewport — the AI chat
  // composer is the clearest example: a fixed-position tab strip clipping the
  // input or breaking the keyboard-avoiding layout reads as a bug, and there
  // is no "go somewhere else" gesture that benefits from the bar being there.
  // Returning null here keeps the Tabs navigator but makes it treat the screen
  // as full-bleed (RN measures the bar at 0 height — same path passwordWall
  // already uses for change-password).
  if (section === "ai-chat") return null;
  if (keyboardShown || passwordWall) return null;

  const bottomPad = Math.max(insets.bottom, spacing.sm);
  // Only reserve the hump cutout when Sales is actually visible — a cashier
  // without `view_sales` gets a flat bar with no raised center and no empty
  // space above.
  const hasFab = visible.some((i) => i.route === "sales");
  const raise = hasFab ? HUMP_DEPTH : 0;

  return (
    // Measured wrapper — this is what react-navigation sees when it decides
    // how much space to reserve for the tab bar (and thus how much to pad
    // screen content with). We want RN to pad screens ONLY by the visible bar
    // portion, so the inner `outer` uses `marginTop: -raise` to subtract its
    // transparent hump cutout from the wrapper's intrinsic height. The hump
    // then visually overflows UPWARD into the content area, where the SVG's
    // transparent wings let real screen content show through — without the
    // visible white bar portion ever covering last-item rows.
    //
    // `box-none` on every layer so taps on the wings fall through to the
    // screen beneath; the Pressables above do all the real tap handling.
    <View style={styles.measuredSlot} pointerEvents="box-none">
      <View
        style={[styles.outer, { paddingTop: raise, marginTop: -raise }]}
        pointerEvents="box-none"
      >
        {hasFab ? (
          <CurvedBarBg raise={raise} />
        ) : (
          // Flat bar fallback — matches the pre-FAB render exactly.
          <View style={[styles.flatBarBg, { top: 0 }]} pointerEvents="none" />
        )}
        <View style={[styles.row, { paddingBottom: bottomPad }]} pointerEvents="box-none">
          {visible.map((item) => {
          const isActive = item.route === activeRoute;
          const onPress = () => {
            if (item.route !== currentRoute) navigation.navigate(item.route);
          };
          if (item.route === "sales") {
            return (
              <SalesFab
                key={item.route}
                label={item.label}
                isActive={isActive}
                onPress={onPress}
              />
            );
          }
          const tint = isActive ? colors.accent : colors.textSecondary;
          const Icon = item.icon;
          const count = item.badge === "tasksUnread" ? tasksUnread : 0;
          return (
            <Pressable
              key={item.route}
              style={styles.item}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={count > 0 ? `${item.label}, ${count} ${t("app.shell.newItems")}` : item.label}
              onPress={onPress}
            >
              <View style={styles.iconWrap}>
                <Icon size={22} color={tint} />
                {count > 0 ? (
                  <View style={styles.badge} pointerEvents="none">
                    <Text style={styles.badgeText}>{badgeText(count)}</Text>
                  </View>
                ) : null}
              </View>
              <Text numberOfLines={1} style={[styles.label, { color: tint }]}>
                {item.label}
              </Text>
              <View style={[styles.underline, !isActive && styles.underlineHidden]} />
            </Pressable>
          );
        })}
        </View>
      </View>
    </View>
  );
}

interface SalesFabProps {
  label: string;
  isActive: boolean;
  onPress: () => void;
}

function SalesFab({ label, isActive, onPress }: SalesFabProps) {
  // RN's built-in Animated handles a one-value scale spring on its own native
  // driver — no need to pull in react-native-reanimated / worklets (that
  // transitive dep tree collides with Metro's hoisted semver v6, which lacks
  // the semver v7 subpath exports worklets needs). useMemo instead of useRef
  // so the lint rule "no ref access during render" stays satisfied; the empty
  // dep list keeps the same single Animated.Value identity across renders.
  const scale = useMemo(() => new Animated.Value(1), []);
  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      stiffness: 400,
      damping: 18,
      mass: 0.5,
    }).start();
  return (
    <Pressable
      style={styles.fabItem}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={label}
      hitSlop={8}
      onPressIn={() => spring(0.92)}
      onPressOut={() => spring(1)}
      onPress={() => {
        // Haptics already used elsewhere (sales.tsx) — same impactAsync pattern.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
    >
      <Animated.View style={[styles.fabCircle, { transform: [{ scale }] }]}>
        <AddShoppingCartIcon size={FAB_ICON} color={colors.onAccent} />
      </Animated.View>
      <Text numberOfLines={1} style={[styles.label, styles.fabLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

interface CurvedBarBgProps { raise: number; }

/**
 * One-piece curved bar background drawn in SVG. Uses `onLayout` to size the
 * canvas in device pixels so the path is drawn at native resolution — a
 * stretched viewBox would distort the hump at narrow screen widths. Rendered
 * with `pointerEvents="none"` so the shape never catches touches: the
 * Pressables above it handle every tap.
 */
function CurvedBarBg({ raise }: CurvedBarBgProps) {
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(0);
  return (
    <View
      style={styles.curvedBg}
      pointerEvents="none"
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      {width > 0 && height > 0 ? (
        <Svg width={width} height={height}>
          <Path
            d={buildBarPath(width, height, raise - HUMP_DEPTH, raise)}
            fill={colors.bg}
            // Hairline that follows the whole top edge — the user's accepted
            // fallback for "soft shadow following the curve" (SVG filters
            // aren't portable across iOS+Android in react-native-svg without
            // extra native work). Border token stays in light/dark parity.
            stroke={colors.border}
            strokeWidth={StyleSheet.hairlineWidth}
          />
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Measured wrapper — react-navigation's BottomTabBar uses this view's
  // intrinsic height to decide screen-content padding. The negative marginTop
  // on `outer` below cancels its own transparent top padding, so this slot
  // reports JUST the visible-bar height (row + bottom insets). overflow:visible
  // lets the hump above still render into the content area above.
  measuredSlot: { overflow: "visible" },
  // Outer: transparent, no border. The runtime `raise` (HUMP_DEPTH when Sales
  // is visible, 0 otherwise) is applied inline as paddingTop so the hump has
  // layout room; the matching negative marginTop on the SAME view (set inline)
  // keeps the measured wrapper's intrinsic height unaffected.
  outer: { backgroundColor: "transparent", overflow: "visible" },
  // Curved bar background wrapper — absolutely positioned, fills the whole
  // outer container so the SVG canvas covers it (`onLayout` reads its height).
  curvedBg: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  // Fallback flat bar used when Sales is filtered out by permissions —
  // matches the pre-FAB render byte-for-byte.
  flatBarBg: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-around",
    paddingTop: spacing.sm,
  },
  // Normal item — unchanged from before the FAB existed. Icon sits inside the
  // visible bar region because the outer container already reserves HUMP_DEPTH
  // of transparent space above.
  item: { flex: 1, alignItems: "center", gap: 4, minHeight: 44 },
  // FAB item — pulled upward so the circle's bottom sits just above the label
  // row and its top half rises into the hump. The negative marginTop also
  // places the label at the same baseline Y as the other six item labels (the
  // offset compensates for the circle being larger than a normal icon AND the
  // normal items reserving 2px underline + 4px gap below their label).
  //
  // Pressable's layout box moves with it, so taps on the raised half still hit
  // the Pressable (no overflow:visible / hitSlop trick required for correctness).
  fabItem: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    minHeight: FAB_SIZE + 20,
    // Pulls the whole FAB column up by HUMP_DEPTH so the circle's center lands
    // on the normal bar top line (half above the line, half below). The
    // Pressable's layout box moves with it, so taps on the raised half still
    // hit the Pressable (no overflow:visible / hitSlop trick required).
    marginTop: -HUMP_DEPTH,
  },
  fabCircle: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    // Ring and brand-blue glow intentionally removed — the hump itself now
    // separates the circle from the bar, which was the whole point of the
    // curve. A very subtle neutral drop keeps the FAB from feeling flat on
    // light surfaces without re-introducing the "glow" aesthetic.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  fabLabel: {
    color: colors.accent,
    fontFamily: fonts.semibold,
    // Normal item labels sit 2px lower than the circle_bottom+gap(4) line
    // because they reserve a 2px underline + 4px gap below them. Push the
    // FAB label down by exactly that offset so all seven labels share one
    // baseline Y across the bar.
    marginTop: 2,
  },
  iconWrap: { position: "relative" },
  // Web parity: `-top-1.5 -end-2` on a 16px danger pill. `end` (not `right`)
  // so it sits past the glyph's trailing edge under the root RTL direction.
  badge: {
    position: "absolute",
    top: -5,
    end: -9,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: radius.full,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontFamily: fonts.bold,
    fontSize: 9,
    lineHeight: 12,
    color: colors.onAccent,
    // Digits in a pill: the count is a number, not a sentence.
    writingDirection: "ltr",
  },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 10 },
  underline: {
    height: 2,
    width: 24,
    borderRadius: 2,
    backgroundColor: colors.accent,
    marginTop: 2,
  },
  // Kept mounted so the label never shifts when the active tab changes.
  underlineHidden: { opacity: 0 },
});
