import { useCallback, useState, type ReactNode } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { XIcon as X } from "phosphor-react-native/src/icons/X";

import { Button } from "@/components/ui/Button";
import { t, useLocale } from "@/i18n";
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

export interface SheetSecondaryAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}

export interface SheetProps {
  visible: boolean;
  /** Close X, backdrop tap and (unless overridden) the Android back button. */
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
 * X is a labelled 44pt button. The panel, close and backdrop carry
 * `${testID}`, `${testID}-close` and `${testID}-backdrop` for Maestro.
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

  const hasFooter = footer !== undefined || primaryAction !== undefined || secondaryAction !== undefined;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onRequestClose ?? onClose}
    >
      <View style={[styles.root, directionStyle(rtl)]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.kav}
        >
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
            <View style={styles.header}>
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
                      <View testID={primaryAction.testID}>
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
                      <View testID={secondaryAction.testID}>
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
