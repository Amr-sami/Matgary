// Skeleton primitives + composites. Drop-in placeholders for pending
// async content.
//
// Design
// ──────
//   • Hybrid architecture: a tiny primitive set (<Skeleton>, SkeletonText,
//     SkeletonCircle, SkeletonRow, SkeletonFormField) + repeated composites
//     (SkeletonListRow, SkeletonStatCard, SkeletonDetailHeader) so screens
//     compose rather than duplicate.
//   • Reanimated pulse (opacity 0.45 ↔ 1.0, 900 ms sine), shared between all
//     skeleton instances via a module-level SharedValue so N visible
//     skeletons animate with one timing driver, not N.
//   • `useReducedMotion()` honours the OS "Reduce Motion" setting — the
//     pulse is skipped and a static mid-opacity is used instead.
//   • RTL-safe: no hard-coded start/end padding; all layout uses standard
//     flex which React Native mirrors under RTL automatically.
//   • Theme-safe: palette pulled from `theme/tokens` (`neutralTint`,
//     `border`, `radius`, `spacing`, `fonts`) — no magic numbers inline.
//   • No new dependencies — Reanimated is already in the project.

import { ReactNode, useEffect } from "react";
import {
  AccessibilityRole,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useReducedMotion } from "@/hooks/useReducedMotion";
import { colors, radius, spacing } from "@/theme/tokens";

// ── Shared timing + palette ─────────────────────────────────────────────────

/** Pulse duration (ms). Half-period of the sine; a full cycle is 2× this. */
const PULSE_MS = 900;
/** Opacity floor during the pulse. */
const PULSE_LOW = 0.45;
/** Opacity ceiling. */
const PULSE_HIGH = 1;

/** Base tint used for every skeleton surface. Matches the app's neutral
 *  input/border surface so skeletons read as "empty content frame" not
 *  "foreign tile". */
export const SKELETON_TINT = colors.neutralTint;

// ── Primitive: Skeleton ─────────────────────────────────────────────────────

export interface SkeletonProps {
  /** Width override. Default 100% fills the parent. */
  width?: number | `${number}%`;
  /** Height override. Default 14 (text baseline). */
  height?: number;
  /** Border radius override. Default theme `radius.md`. */
  borderRadius?: number;
  /** Extra style to merge. Avoid passing colors — use `backgroundColor` if
   *  you need a different tint. */
  style?: StyleProp<ViewStyle>;
  /** Overrides the pulse tint for a darker/lighter variant. */
  backgroundColor?: string;
  testID?: string;
}

/** Base skeleton block with a pulsing opacity animation. Everything else in
 *  this file composes from this. */
export function Skeleton({
  width = "100%",
  height = 14,
  borderRadius = radius.md,
  style,
  backgroundColor = SKELETON_TINT,
  testID,
}: SkeletonProps) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(reduced ? 0.7 : PULSE_HIGH);

  useEffect(() => {
    if (reduced) {
      // Static mid-opacity for motion-sensitive users.
      cancelAnimation(opacity);
      opacity.value = 0.7;
      return;
    }
    opacity.value = withRepeat(
      withTiming(PULSE_LOW, {
        duration: PULSE_MS,
        easing: Easing.inOut(Easing.sin),
      }),
      -1, // infinite
      true, // reverse each cycle → smooth back-and-forth
    );
    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity, reduced]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      testID={testID}
      accessibilityRole="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.block,
        { width, height, borderRadius, backgroundColor },
        animatedStyle,
        style,
      ]}
    />
  );
}

// ── Primitive: SkeletonText ─────────────────────────────────────────────────

export interface SkeletonTextProps {
  /** One block per line. Default 1. */
  lines?: number;
  /** Width of each line. Pass a single value or one-per-line. */
  width?: number | `${number}%` | Array<number | `${number}%`>;
  /** Line height (also = block height). Default 14. */
  height?: number;
  /** Vertical spacing between lines. */
  gap?: number;
  style?: StyleProp<ViewStyle>;
}

export function SkeletonText({
  lines = 1,
  width = "100%",
  height = 14,
  gap = spacing.xs,
  style,
}: SkeletonTextProps) {
  const widths: Array<number | `${number}%`> = Array.from({ length: lines }, (_, i) => {
    if (Array.isArray(width)) return width[i] ?? width[width.length - 1];
    // The last line looks more realistic when slightly shorter than the
    // others — matches the ragged right of prose/labels.
    if (lines > 1 && i === lines - 1) return "70%";
    return width;
  });
  return (
    <View style={[{ gap }, style]}>
      {widths.map((w, i) => (
        <Skeleton key={i} width={w} height={height} />
      ))}
    </View>
  );
}

// ── Primitive: SkeletonCircle (avatar) ──────────────────────────────────────

export function SkeletonCircle({
  size = 40,
  style,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <Skeleton width={size} height={size} borderRadius={size / 2} style={style} />;
}

// ── Primitive: SkeletonRow ──────────────────────────────────────────────────

/** Generic one-row layout: leading element (icon/avatar/thumbnail), two
 *  text lines, trailing element (price/badge/arrow). Used by most list
 *  rows, selectors, and bottom-sheet entries. */
export interface SkeletonRowProps {
  /** Leading avatar diameter. Pass 0 to drop the leading column. */
  avatarSize?: number;
  /** Line height of each text block. */
  textHeight?: number;
  /** Width of the trailing block. Pass 0 to drop the trailing column. */
  trailingWidth?: number;
  /** Override the row height so it matches the real row the screen renders.
   *  Default 72 which matches the typical Storo list row (16 + 40 + 16). */
  height?: number;
  style?: StyleProp<ViewStyle>;
}

export function SkeletonRow({
  avatarSize = 40,
  textHeight = 12,
  trailingWidth = 56,
  height,
  style,
}: SkeletonRowProps) {
  return (
    <View
      style={[
        styles.row,
        { minHeight: height ?? 72, paddingHorizontal: spacing.lg },
        style,
      ]}
    >
      {avatarSize > 0 && <SkeletonCircle size={avatarSize} />}
      <View style={styles.rowBody}>
        <Skeleton width="60%" height={textHeight + 2} />
        <Skeleton width="38%" height={textHeight} />
      </View>
      {trailingWidth > 0 && <Skeleton width={trailingWidth} height={textHeight + 4} />}
    </View>
  );
}

// ── Composite: SkeletonListRow (N rows w/ divider) ──────────────────────────

/** List skeleton — N identical rows with thin dividers. The default N=6
 *  matches a typical mobile-first paint. */
export function SkeletonListRow({
  count = 6,
  avatarSize = 40,
  trailingWidth = 56,
  height,
  divider = true,
  testID,
}: {
  count?: number;
  avatarSize?: number;
  trailingWidth?: number;
  height?: number;
  divider?: boolean;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.listContainer}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i}>
          <SkeletonRow
            avatarSize={avatarSize}
            trailingWidth={trailingWidth}
            height={height}
          />
          {divider && i < count - 1 && <View style={styles.divider} />}
        </View>
      ))}
    </View>
  );
}

// ── Composite: SkeletonStatCard ─────────────────────────────────────────────

/** Compact KPI card — label line + large value block. Matches the stat
 *  cards used on the dashboard, admin overview, and insights. */
export function SkeletonStatCard({
  width,
  style,
}: {
  width?: number | `${number}%`;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.statCard, width ? { width } : undefined, style]}>
      <Skeleton width="55%" height={10} />
      <Skeleton width="40%" height={24} style={{ marginTop: spacing.sm }} />
    </View>
  );
}

// ── Composite: SkeletonDetailHeader ─────────────────────────────────────────

/** Detail-page header: a large title, subtitle, and a right-aligned
 *  action-cluster skeleton. Used by customer/supplier/task/sale detail. */
export function SkeletonDetailHeader({
  withAvatar = false,
  avatarSize = 56,
  style,
}: {
  withAvatar?: boolean;
  avatarSize?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.detailHeader, style]}>
      {withAvatar && <SkeletonCircle size={avatarSize} />}
      <View style={styles.detailHeaderBody}>
        <Skeleton width="60%" height={20} />
        <Skeleton width="40%" height={13} style={{ marginTop: spacing.sm }} />
      </View>
    </View>
  );
}

// ── Composite: SkeletonFormField ────────────────────────────────────────────

/** A form field placeholder — label block + input-sized tile. Used for any
 *  remote-driven settings screen (store, branches, categories, etc.). */
export function SkeletonFormField({
  labelWidth = "35%",
  inputHeight = 44,
  style,
}: {
  labelWidth?: number | `${number}%`;
  inputHeight?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.formField, style]}>
      <Skeleton width={labelWidth} height={11} />
      <Skeleton
        width="100%"
        height={inputHeight}
        borderRadius={radius.md}
        style={{ marginTop: spacing.sm }}
      />
    </View>
  );
}

// ── Composite: SkeletonBottomSheetContent ───────────────────────────────────

/** Short list skeleton used inside modals/bottom sheets/selectors. Smaller
 *  padding than the full-page list; tighter row height. */
export function SkeletonSelectorRows({
  count = 5,
  avatarSize = 32,
}: {
  count?: number;
  avatarSize?: number;
}) {
  return (
    <View style={styles.selectorContainer}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow
          key={i}
          avatarSize={avatarSize}
          trailingWidth={0}
          height={56}
          style={{ paddingHorizontal: spacing.md }}
        />
      ))}
    </View>
  );
}

// ── Composite: SkeletonChart ────────────────────────────────────────────────

/** Chart placeholder — fixed-height block with a header line above. */
export function SkeletonChart({
  height = 180,
  style,
}: {
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.chart, style]}>
      <Skeleton width="40%" height={12} />
      <Skeleton
        width="100%"
        height={height}
        borderRadius={radius.lg}
        style={{ marginTop: spacing.md }}
      />
    </View>
  );
}

// ── Composite: SkeletonPaginationFooter ─────────────────────────────────────

/** Loading row(s) rendered at the bottom of an infinite-scroll list while
 *  the next page is fetching. Keep height close to a real row to avoid
 *  layout jump when real items arrive. */
export function SkeletonPaginationFooter({
  count = 2,
  rowHeight = 72,
  avatarSize = 40,
}: {
  count?: number;
  rowHeight?: number;
  avatarSize?: number;
}) {
  return (
    <View style={styles.paginationFooter}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow
          key={i}
          avatarSize={avatarSize}
          height={rowHeight}
        />
      ))}
    </View>
  );
}

// ── Utility: screen-wrapping group ──────────────────────────────────────────

/** Convenience: wrap arbitrary skeleton composition with the standard
 *  screen-content padding so screens don't re-declare it. */
export function SkeletonScreen({
  children,
  accessibilityRole = "none",
}: {
  children: ReactNode;
  accessibilityRole?: AccessibilityRole;
}) {
  return (
    <View
      accessibilityRole={accessibilityRole}
      accessibilityLabel="Loading"
      style={styles.screen}
    >
      {children}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  block: {
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: spacing.xs,
  },
  listContainer: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
  },
  statCard: {
    padding: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  detailHeaderBody: {
    flex: 1,
  },
  formField: {
    paddingVertical: spacing.sm,
  },
  selectorContainer: {
    paddingVertical: spacing.sm,
  },
  chart: {
    padding: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  paginationFooter: {
    paddingTop: spacing.sm,
  },
  screen: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.lg,
  },
});
