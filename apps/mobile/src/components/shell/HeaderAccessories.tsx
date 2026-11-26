import { Image, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";

import { NotificationBell } from "./NotificationBell";
import { OfflineChip } from "./OfflineChip";
import { t } from "@/i18n";
import { colors, spacing } from "@/theme/tokens";

/** The custom AI-bot icon (bundled PNG). `tintColor` lets us keep one asset
 *  and recolour it to brand blue — the file itself is pure black-on-transparent. */
const CHAT_AI_ICON = require("../../../assets/images/ai-bot.png");

/**
 * The row above every screen title: offline/sync state, the AI shortcut,
 * and the bell. Each chip is owned by its feature and renders null until it
 * has something to show, so the row collapses to nothing on an online tenant
 * with no notifications.
 */
export function HeaderAccessories() {
  const router = useRouter();
  return (
    <View style={styles.row}>
      <OfflineChip />
      <View style={styles.spacer} />
      {/* AI shortcut + bell paired. The two icons match sizes (22pt) and
          sit in a compact sub-row so they read as one action cluster. The
          outer `spacer` keeps the OfflineChip distant on the far side. */}
      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push("/ai-chat")}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.insights.ai.title")}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          <Image
            source={CHAT_AI_ICON}
            style={styles.aiIcon}
            resizeMode="contain"
            // tintColor recolours the PNG's opaque pixels — keeps a single
            // asset blue without us shipping a pre-coloured variant.
          />
        </Pressable>
        <NotificationBell />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, alignSelf: "stretch" },
  spacer: { flex: 1 },
  /** Compact pair-row — bell + AI live together, no visible gap between
   *  their glyphs. 2px keeps them from literally touching. */
  actions: { flexDirection: "row", alignItems: "center", gap: 2 },
  btn: {
    // Tight button box — just big enough for the 22pt glyph plus a hair of
    // padding. Tap target is widened via `hitSlop` on the Pressable itself
    // so the UI stays dense without sacrificing accessibility (effective
    // touch area is still comfortably past the 44pt minimum).
    paddingHorizontal: 4,
    paddingVertical: 4,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  btnPressed: { backgroundColor: colors.accentLight, borderRadius: 999 },
  aiIcon: {
    width: 22,
    height: 22,
    tintColor: colors.accent,
  },
});
