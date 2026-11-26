import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { CloudArrowUpIcon as CloudArrowUp } from "phosphor-react-native/src/icons/CloudArrowUp";
import { PauseCircleIcon as PauseCircle } from "phosphor-react-native/src/icons/PauseCircle";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { WifiSlashIcon as WifiSlash } from "phosphor-react-native/src/icons/WifiSlash";

import { t } from "@/i18n";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * Header chip for the offline engine. Renders nothing in the happy case
 * (online, nothing queued, nothing failed) so the header stays quiet; every
 * other state is a tap-through to /sync.
 *
 * Priority when several apply: failed > paused > syncing > queued-but-offline > offline.
 * A failed sale is the one thing a cashier must not miss (§6.3 defect 4).
 */
export function OfflineChip() {
  const router = useRouter();
  const status = useSession((s) => s.status);
  const online = useOffline((s) => s.online);
  const draining = useOffline((s) => s.draining);
  const queued = useOffline((s) => s.queued);
  const failed = useOffline((s) => s.failed);
  const paused = useOffline((s) => s.paused);

  if (status !== "signedIn") return null;
  if (online && queued === 0 && failed === 0) return null;

  let label: string;
  let tone: { bg: string; fg: string };
  let icon: ReactNode;

  if (failed > 0) {
    label = t("mobile.offline.chipFailed", { count: failed });
    tone = { bg: colors.dangerLight, fg: colors.danger };
    icon = <WarningCircle size={16} color={tone.fg} weight="fill" />;
  } else if (paused && queued > 0) {
    // A billing / session wall stopped the drain: say so, or "N pending"
    // that never moves looks like a bug.
    label = t("mobile.offline.chipPaused", { count: queued });
    tone = { bg: colors.warningTint, fg: colors.warningStrong };
    icon = <PauseCircle size={16} color={tone.fg} weight="fill" />;
  } else if (draining) {
    label = t("mobile.offline.chipSyncing", { count: queued });
    tone = { bg: colors.accentLight, fg: colors.accent };
    icon = <ActivityIndicator size="small" color={tone.fg} />;
  } else if (!online) {
    label = queued > 0 ? t("mobile.offline.chipOfflineQueued", { count: queued }) : t("mobile.offline.chipOffline");
    tone = { bg: colors.warningTint, fg: colors.warningStrong };
    icon = <WifiSlash size={16} color={tone.fg} />;
  } else {
    label = t("mobile.offline.chipQueued", { count: queued });
    tone = { bg: colors.accentLight, fg: colors.accent };
    icon = <CloudArrowUp size={16} color={tone.fg} />;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${t("mobile.offline.chipHint")}`}
      // 28px pill + 8px each side = MIN_TOUCH (44) effective target.
      hitSlop={{ top: (MIN_TOUCH - 28) / 2, bottom: (MIN_TOUCH - 28) / 2, left: 8, right: 8 }}
      onPress={() => router.push("/sync")}
      style={({ pressed }) => [styles.chip, { backgroundColor: tone.bg }, pressed && styles.pressed]}
    >
      {icon}
      <Text style={[styles.label, { color: tone.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 28,
    height: 28,
    maxWidth: 160,
    marginVertical: (MIN_TOUCH - 28) / 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  pressed: { opacity: 0.7 },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 16,
  },
});
