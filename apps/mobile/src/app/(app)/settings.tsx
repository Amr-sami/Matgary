import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { CaretLeft } from "phosphor-react-native";

import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__settings.png — the hub, with the sub-pages the web splits out
 * (branches, notifications, digest, security).
 *
 * TODO(phase-4): each row below needs its own screen; they are listed here so
 * the hub is complete and the destinations are visible, not hidden.
 */
const SECTIONS = [
  { key: "branches", label: "الفروع", hint: "إدارة الفروع والتبديل بينها" },
  { key: "notifications", label: "الإشعارات", hint: "ما الذي يصلك ومتى" },
  { key: "digest", label: "الملخص اليومي", hint: "تقرير يومي على واتساب" },
  { key: "receipt", label: "تصميم الإيصال", hint: "شعار المتجر وبيانات الفاتورة" },
  { key: "security", label: "الأمان", hint: "كلمة المرور والتحقق بخطوتين" },
] as const;

export default function SettingsScreen() {
  const me = useSession((s) => s.me);

  return (
    <Screen title="الإعدادات">
      <Card>
        <Text style={styles.store}>{me?.tenant.name}</Text>
        <Text style={styles.meta}>
          {me?.tenant.slug} · الفرع الحالي: {me?.branch.name}
        </Text>
      </Card>

      <View style={styles.list}>
        {SECTIONS.map((s) => (
          <Pressable key={s.key} style={styles.row} accessibilityRole="button">
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>{s.label}</Text>
              <Text numberOfLines={1} style={styles.rowHint}>
                {s.hint}
              </Text>
            </View>
            <CaretLeft size={16} color={colors.textSecondary} />
          </Pressable>
        ))}
      </View>

      <Card title="الفروع المتاحة">
        {(me?.branches ?? []).map((b) => (
          <View key={b.id} style={styles.branchRow}>
            <Text style={styles.branchName}>{b.name}</Text>
            <Switch
              value={b.id === me?.branch.id}
              disabled
              trackColor={{ true: colors.accent, false: colors.border }}
            />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  store: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: 2, ...RTL_TEXT },
  list: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  branchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
  },
  branchName: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
});
