import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { StorefrontIcon as Storefront } from "phosphor-react-native/src/icons/Storefront";
import { ApiError, type BranchSummary } from "@matgary/api-client";

import { t, useLocale } from "@/i18n";
import { useSession } from "@/stores/session";
import { directionStyle, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** How long the chip wears its "switched to X" face before reverting. */
const CONFIRM_MS = 1800;

/**
 * Offline, timed out and server-down each get their own line — the user can
 * act on those (move, wait, retry). Everything else, including the server
 * quietly refusing an id that is not on the allow-list, is "couldn't switch".
 */
function switchErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case "offline":
        return t("mobile.common.offline");
      case "timeout":
        return t("mobile.common.timeout");
      case "server":
        return t("mobile.common.serverError");
    }
  }
  return t("app.branchesPage.toast.switchFailed");
}

/**
 * Header chip: the active branch, and the way to change it.
 *
 * There is no branch picker anywhere in the shipped web app (gap analysis
 * §1.4 — `Header.tsx` is imported and never rendered), so this is the app's
 * own surface. Everything the user sees — sales, stock, expenses, reports —
 * belongs to ONE branch, and on a phone that is easy to forget, so the chip
 * is always in view rather than buried in Settings.
 *
 * Who can switch: whoever `/api/v1/me` gives more than one branch to. Owners
 * get every branch; staff get their allow-list, already filtered
 * server-side. The web's `useBranches().switchTo` is gated the same way
 * (`getAccessibleBranches`, 403 otherwise), so there is no owner-only check
 * here — a single-branch user simply never sees the chip.
 *
 * How switching works: `switchBranch` re-reads `/me` with the candidate id
 * as a per-request `X-Branch-Id`; the server echoes back the branch it
 * actually resolved, and only then does the store adopt it (header, disk,
 * `me`). An id not on the allow-list resolves to a different branch, which
 * the store surfaces as a thrown error instead of a chip that claims a
 * branch we never got. Every query in the app is branch-scoped, so the whole
 * cache is invalidated, not a list — and the store drops the POS cart, whose
 * lines were priced and stock-checked against the old branch.
 */
export function BranchSwitcher() {
  const me = useSession((s) => s.me);
  const switchBranch = useSession((s) => s.switchBranch);
  const refreshMe = useSession((s) => s.refreshMe);
  const rtl = useLocale((s) => s.locale === "ar");
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const confirmOpacity = useRef(new Animated.Value(0)).current;
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  // `me.branches` only travels with /me, so a branch created, renamed or
  // deactivated in Settings since launch is not in the list yet. Refresh it
  // as the sheet opens; the stale list stays on screen until the fresh one
  // lands, and a failure here is not worth an error — the user is about to
  // find out by picking, if the network is really gone.
  useEffect(() => {
    if (!open) return;
    refreshMe().catch(() => {});
  }, [open, refreshMe]);

  const showConfirmation = useCallback(
    (name: string) => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirmed(name);
      confirmOpacity.setValue(0);
      Animated.timing(confirmOpacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      confirmTimer.current = setTimeout(() => {
        Animated.timing(confirmOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(
          () => setConfirmed(null),
        );
      }, CONFIRM_MS);
    },
    [confirmOpacity],
  );

  const branches: BranchSummary[] = me?.branches ?? [];
  // A single-branch tenant has nothing to switch to — the row collapses.
  if (!me || branches.length <= 1) return null;

  const activeId = me.branch.id;
  const activeName =
    me.branch.name ?? branches.find((b) => b.id === activeId)?.name ?? branches[0]?.name ?? "";

  const close = () => {
    if (pendingId) return; // a switch is in flight; let it finish
    setOpen(false);
    setError(null);
  };

  const select = async (branch: BranchSummary) => {
    if (pendingId) return;
    if (branch.id === activeId) {
      close();
      return;
    }
    setPendingId(branch.id);
    setError(null);
    try {
      // Resolves only once the server has echoed the new id back; an id it
      // refused (not on the allow-list, deactivated) throws, and so does a
      // network failure. The store also drops the POS cart on success.
      await switchBranch(branch.id);
      // Everything is branch-scoped. Do not await — the refetches can take a
      // while and the sheet should close the moment the switch is confirmed.
      void queryClient.invalidateQueries();
      Haptics.selectionAsync().catch(() => {});
      setPendingId(null);
      setOpen(false);
      showConfirmation(branch.name);
    } catch (err) {
      setPendingId(null);
      setError(switchErrorMessage(err));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    }
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.branchSwitcher.a11y", { name: activeName })}
        hitSlop={{ top: 6, bottom: 6 }}
        testID="branch-chip"
        style={({ pressed }) => [styles.chip, confirmed && styles.chipConfirmed, pressed && styles.chipPressed]}
      >
        {confirmed ? (
          <Animated.View style={[styles.chipInner, { opacity: confirmOpacity }]}>
            <Check size={14} weight="bold" color={colors.successStrong} />
            <Text numberOfLines={1} style={[styles.chipText, styles.chipTextConfirmed]}>
              {t("mobile.branchSwitcher.switchedTo", { name: confirmed })}
            </Text>
          </Animated.View>
        ) : (
          <View style={styles.chipInner}>
            <Storefront size={14} weight="fill" color={colors.accent} />
            <Text numberOfLines={1} style={styles.chipText} testID="branch-chip-label">
              {activeName}
            </Text>
            <CaretDown size={12} weight="bold" color={colors.textSecondary} />
          </View>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <View style={[styles.overlay, directionStyle(rtl)]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
            <View style={styles.grabber} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{t("mobile.branchSwitcher.title")}</Text>
              <Text style={styles.sheetHint}>{t("mobile.branchSwitcher.hint")}</Text>
            </View>

            <ScrollView bounces={false} contentContainerStyle={styles.list}>
              {branches.map((branch) => {
                const active = branch.id === activeId;
                const pending = branch.id === pendingId;
                return (
                  <Pressable
                    key={branch.id}
                    onPress={() => void select(branch)}
                    disabled={pendingId !== null}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active, busy: pending, disabled: pendingId !== null }}
                    accessibilityLabel={
                      active ? `${branch.name} — ${t("app.branchesPage.labels.current")}` : branch.name
                    }
                    testID="branch-option"
                    style={({ pressed }) => [
                      styles.row,
                      active && styles.rowActive,
                      pressed && !active && styles.rowPressed,
                    ]}
                  >
                    <View style={[styles.rowIcon, active && styles.rowIconActive]}>
                      <Storefront
                        size={18}
                        weight={active ? "fill" : "regular"}
                        color={active ? colors.accent : colors.textSecondary}
                      />
                    </View>
                    <View style={styles.rowBody}>
                      <Text numberOfLines={1} style={[styles.rowName, active && styles.rowNameActive]} testID="branch-option-name">
                        {branch.name}
                      </Text>
                      {(branch.isPrimary || active) && (
                        <Text numberOfLines={1} style={styles.rowMeta}>
                          {[
                            branch.isPrimary ? t("app.branchesPage.labels.primary") : null,
                            active ? t("app.branchesPage.labels.current") : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      )}
                    </View>
                    <View style={styles.rowTrailing}>
                      {pending ? (
                        <ActivityIndicator size="small" color={colors.accent} />
                      ) : active ? (
                        <Check size={20} weight="bold" color={colors.accent} />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {pendingId && !error ? (
              <Text style={styles.status}>{t("mobile.branchSwitcher.switching")}</Text>
            ) : null}
            {error ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Chip — visually compact (36) but the touch target reaches MIN_TOUCH via hitSlop.
  chip: {
    minHeight: 36,
    maxWidth: 220,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    flexShrink: 1,
  },
  chipPressed: { backgroundColor: colors.accentLight },
  chipConfirmed: { borderColor: colors.successStrong, backgroundColor: colors.successLight },
  chipInner: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2 },
  chipText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 13, color: colors.text, flexShrink: 1 },
  chipTextConfirmed: { color: colors.successStrong },

  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "80%",
    paddingTop: spacing.sm,
    ...elevation.modal,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  sheetHeader: { paddingHorizontal: spacing.xl, gap: spacing.xs, marginBottom: spacing.md },
  sheetTitle: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 18, color: colors.accent },
  sheetHint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, lineHeight: 20 },

  list: { paddingHorizontal: spacing.md, gap: spacing.xs },
  row: {
    minHeight: MIN_TOUCH + 12,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "transparent",
  },
  rowActive: { backgroundColor: colors.accentLight, borderColor: colors.accentLight },
  rowPressed: { backgroundColor: colors.neutralTint },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.neutralTint,
  },
  rowIconActive: { backgroundColor: colors.bg },
  rowBody: { flex: 1, gap: 2 },
  rowName: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 15, color: colors.text },
  rowNameActive: { ...RTL_TEXT, fontFamily: fonts.bold, color: colors.accent },
  rowMeta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  rowTrailing: { width: 24, alignItems: "center", justifyContent: "center" },

  status: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  errorBox: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerLight,
  },
  errorText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
});
