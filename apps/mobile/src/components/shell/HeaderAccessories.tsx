import { StyleSheet, View } from "react-native";

import { BranchSwitcher } from "./BranchSwitcher";
import { NotificationBell } from "./NotificationBell";
import { OfflineChip } from "./OfflineChip";
import { spacing } from "@/theme/tokens";

/**
 * The row above every screen title: active branch, offline/sync state, bell.
 * Each chip is owned by its feature and renders null until it has something
 * to show, so the row collapses to nothing on a single-branch, online tenant
 * with no notifications.
 */
export function HeaderAccessories() {
  return (
    <View style={styles.row}>
      <BranchSwitcher />
      <OfflineChip />
      <View style={styles.spacer} />
      <NotificationBell />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, alignSelf: "stretch" },
  spacer: { flex: 1 },
});
