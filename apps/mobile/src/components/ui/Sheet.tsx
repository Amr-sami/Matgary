import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useIsFocused } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { XIcon as X } from "phosphor-react-native/src/icons/X";

import { Button } from "@/components/ui/Button";
import { t, useLocale } from "@/i18n";
import { useAppLock } from "@/stores/appLock";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

export interface SheetAction {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** Danger fill (delete, void, reject). Label stays white. */
  destructive?: boolean;
  testID?: string;
}

/**
 * Outline button beneath the primary — in practice always "Cancel". It is
 * then the sheet's ONE dismiss affordance: the header X is not rendered, so
 * a form never shows two controls for the same close.
 */
export interface SheetSecondaryAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}

export interface SheetProps {
  visible: boolean;
  /**
   * Close X (hidden when the default footer carries a `secondaryAction`),
   * backdrop tap and (unless overridden) the Android back button.
   */
  onClose: () => void;
  /**
   * Android back / iOS swipe-dismiss. Defaults to `onClose`; a wizard passes
   * its "go back one step" here so a hardware back does not drop the draft.
   */
  onRequestClose?: () => void;
  title: string;
  subtitle?: string;
  /** Scrollable body. */
  children: ReactNode;
  /**
   * Custom footer. When omitted, `primaryAction`/`secondaryAction` render the
   * ONE app-wide footer: full-width primary, outline secondary beneath it.
   */
  footer?: ReactNode;
  primaryAction?: SheetAction;
  secondaryAction?: SheetSecondaryAction;
  /** "auto" hugs the content up to ~92% of the screen; "full" fills it. */
  size?: "auto" | "full";
  testID?: string;
  /** Tap on the dim backdrop closes the sheet. Default true. */
  closeOnBackdrop?: boolean;
  /**
   * Set false when the body hosts its own virtualized list (FlatList) — a
   * FlatList inside a ScrollView neither virtualizes nor scrolls. The body
   * then becomes a plain flex column the list can fill.
   */
  scrollable?: boolean;
  /** Extra style for the body content container (padding/gap overrides). */
  bodyStyle?: StyleProp<ViewStyle>;
}

/**
 * The app's one bottom sheet.
 *
 * Every form and picker that used to build its own <Modal> — with its own
 * title size, its own footer layout and its own inset math — now renders
 * through this. RN's <Modal> mounts a separate native root, so three things
 * the screen root normally provides are re-applied here on purpose:
 *
 *  - `directionStyle(rtl)` on the root View, or every Text inside would lay
 *    out LTR under Arabic (see theme/rtl.ts).
 *  - Safe-area bottom inset on the footer, so the CTAs clear the home
 *    indicator. The footer is pinned OUTSIDE the ScrollView: inside it, the
 *    CTAs were clipped whenever the form outgrew the screen.
 *  - The KeyboardAvoidingView is the full-height flex-end container and the
 *    scrim Pressable sits INSIDE it: with an auto-height KAV the panel's
 *    maxHeight resolved against its own content and clipped the footer.
 *
 * Accessibility: the panel is `accessibilityViewIsModal` so VoiceOver does
 * not wander into the dimmed screen behind; the title is a header; the close
 * X is a labelled 44pt button — rendered only when the default footer has no
 * `secondaryAction`, so a sheet never offers X and Cancel for the same
 * dismiss. The panel, close and backdrop carry `${testID}`,
 * `${testID}-close` and `${testID}-backdrop` for Maestro.
 *
 * Presence is decided by `useSheetPresence` below, not by `visible` alone:
 * a Modal is its own native window, so it neither leaves with the screen
 * that opened it nor stays under the app-lock cover on its own.
 */
export function Sheet({
  visible,
  onClose,
  onRequestClose,
  title,
  subtitle,
  children,
  footer,
  primaryAction,
  secondaryAction,
  size = "auto",
  testID,
  closeOnBackdrop = true,
  scrollable = true,
  bodyStyle,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const rtl = useLocale((s) => s.locale) === "ar";
  const shown = useSheetPresence(visible, onClose);

  const hasFooter = footer !== undefined || primaryAction !== undefined || secondaryAction !== undefined;
  // The default footer's secondary button is the Cancel; with it the header
  // X would be a second control for the same close.
  const showClose = footer !== undefined || secondaryAction === undefined;

  return (
    <Modal
      visible={shown}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onRequestClose ?? onClose}
    >
      <View style={[styles.root, directionStyle(rtl)]}>
        {/* Android: a translucent-status-bar Modal window never resizes for the
            keyboard (adjustResize is ignored), so the footer sat under the IME
            (Pixel 7 review, categories sheet). Padding by the keyboard height
            keeps the pinned CTAs visible on both platforms. */}
        <KeyboardAvoidingView behavior="padding" style={styles.kav}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={closeOnBackdrop ? onClose : undefined}
            accessibilityRole="button"
            accessibilityLabel={t("app.common.close")}
            testID={testID ? `${testID}-backdrop` : undefined}
          />
          <View
            style={[
              styles.panel,
              size === "full"
                ? [styles.panelFull, { marginTop: insets.top + spacing.md }]
                : styles.panelAuto,
            ]}
            accessibilityViewIsModal
            testID={testID}
          >
            <View style={styles.grabber} />
            <View style={[styles.header, !showClose && styles.headerNoClose]}>
              <View style={styles.headerText}>
                <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text numberOfLines={2} style={styles.subtitle}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {showClose ? (
                <Pressable
                  onPress={onClose}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t("app.common.close")}
                  testID={testID ? `${testID}-close` : undefined}
                  style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
                >
                  <X size={22} color={colors.text} />
                </Pressable>
              ) : null}
            </View>

            {scrollable ? (
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={[styles.body, bodyStyle]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
              >
                {children}
              </ScrollView>
            ) : (
              <View style={[styles.scroll, styles.body, styles.bodyStatic, bodyStyle]}>{children}</View>
            )}

            {hasFooter ? (
              <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
                {footer !== undefined ? (
                  footer
                ) : (
                  <>
                    {primaryAction ? (
                      // Button takes no testID; the app's convention is a
                      // wrapping View, which Maestro taps at its centre.
                      <View testID={primaryAction.testID} collapsable={false}>
                        <Button
                          label={primaryAction.label}
                          onPress={primaryAction.onPress}
                          loading={primaryAction.loading}
                          disabled={primaryAction.disabled}
                          style={primaryAction.destructive ? styles.destructive : undefined}
                        />
                      </View>
                    ) : null}
                    {secondaryAction ? (
                      // Default id `${testID}-cancel`: with the header X hidden this is the
                      // sheet's dismiss control, so flows need a stable handle for it.
                      // collapsable={false}: Android flattens a layout-only View and its
                      // testID with it.
                      <View
                        testID={secondaryAction.testID ?? (testID ? `${testID}-cancel` : undefined)}
                        collapsable={false}
                      >
                        <Button
                          label={secondaryAction.label}
                          variant="outline"
                          onPress={secondaryAction.onPress}
                          disabled={secondaryAction.disabled}
                        />
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

/**
 * Whether the screen hosting this component is the focused route.
 *
 * `useIsFocused` throws outside a navigator ("Couldn't find a navigation
 * object"); a sheet mounted above the Stack — a shell component, the lock
 * gate — has no route to lose, so it counts as focused. The try/catch is
 * hook-safe: whether the hook throws is fixed by the component's place in
 * the tree, so the hook sequence is the same on every render of one instance.
 */
function useHostFocused(): boolean {
  try {
    return useIsFocused();
  } catch {
    return true;
  }
}

/**
 * The two reasons a sheet must NOT be on screen although its owner still says
 * `visible` — shared by Sheet and ScannerSheet (both are RN <Modal>s, and an
 * RN Modal is a separate native window that knows nothing about routes or
 * covers):
 *
 *  1. The screen that opened it lost focus. A deep link, a notification tap
 *     or a tab switch navigates the Stack UNDERNEATH the modal window, so the
 *     sheet would stay open over a screen it does not belong to (observed: the
 *     settle-invoice sheet floating over Suppliers). Losing focus closes it
 *     for good through `onClose` — the owner's state follows, so nothing
 *     re-opens when the route comes back.
 *
 *  2. The app lock is armed. AppLockGate's cover is itself a Modal presented
 *     from the root view controller; while a sheet's modal window is up, iOS
 *     refuses a second presentation from the same presenter, so the sheet
 *     would sit where the cover should be. The sheet is hidden — not closed —
 *     while `locked`, and comes back with its content once the user unlocks.
 *
 * Returns the effective `visible` to hand to the Modal.
 */
export function useSheetPresence(visible: boolean, onClose: () => void): boolean {
  const focused = useHostFocused();
  const locked = useAppLock((s) => s.locked);

  useEffect(() => {
    if (visible && !focused) onClose();
  }, [visible, focused, onClose]);

  return visible && !locked;
}

/** `const sheet = useSheet(); <Button onPress={sheet.open} /> <Sheet visible={sheet.visible} onClose={sheet.close} …/>` */
export function useSheet(initial = false) {
  const [visible, setVisible] = useState(initial);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  return { visible, open, close, setVisible };
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  kav: { flex: 1, justifyContent: "flex-end" },
  panel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border,
    ...elevation.modal,
  },
  panelAuto: { maxHeight: "92%" },
  panelFull: { flex: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingStart: spacing.xl,
    paddingEnd: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  /** Without the X the end edge matches the start edge. */
  headerNoClose: { paddingEnd: spacing.xl },
  headerText: { flex: 1, gap: 2, paddingTop: (MIN_TOUCH - 26) / 2 },
  title: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 18, lineHeight: 26, color: colors.text },
  subtitle: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  close: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { backgroundColor: colors.neutralTint },
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: spacing.lg },
  bodyStatic: { flexGrow: 1 },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  destructive: { backgroundColor: colors.danger, borderColor: colors.danger },
});
