import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  CaretLeft,
  ChatCircle,
  Receipt,
  ShieldCheck,
  Storefront,
} from "phosphor-react-native";

import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__settings.png — the hub.
 *
 * Every string here comes from apps/web/dictionaries/ar.json → app.settingsPage
 * (`branches`, `digestTile`, `notificationsTile`), so the two clients say the
 * same words rather than two translations of the same idea.
 *
 * The web's tile is `flex items-center gap-3` with the glyph in
 * text-secondary, a bold title, an xs hint and a ChevronLeft — reproduced
 * below rather than folded into Card, because Card's `title` prop renders a
 * heading block, not a row.
 */
interface Tile {
  key: string;
  route: string;
  icon: typeof Storefront;
  title: string;
  hint: string;
  /** Owner-only, matching the `isOwner &&` guards on the web page. */
  ownerOnly: boolean;
  /** Rendered but not pressable — there is no destination yet. */
  soon?: boolean;
}

export default function SettingsScreen() {
  const router = useRouter();
  const me = useSession((s) => s.me);
  const isOwner = me?.isOwner ?? false;
  const branchCount = me?.branches.length ?? 0;

  const tiles: Tile[] = [
    {
      key: "branches",
      route: "/settings/branches",
      icon: Storefront,
      title: "إدارة الفروع",
      hint:
        branchCount <= 1
          ? "أضف فرعاً جديداً لتتبع المبيعات والمخزون لكل موقع على حدة."
          : "إدارة الفروع، تعطيل أو حذف فرع، وتعديل بيانات الموقع.",
      ownerOnly: true,
    },
    {
      key: "digest",
      route: "/settings/digest",
      icon: ChatCircle,
      title: "الملخص اليومي على واتساب",
      hint: "ابعت لنفسك كل يوم رسالة فيها كل المهم في كل فرع",
      ownerOnly: true,
    },
    {
      key: "notifications",
      route: "/settings/notifications",
      icon: ChatCircle,
      title: "الإشعارات",
      hint: "اختر الأحداث اللي تنبّهك داخل التطبيق أو بالبريد.",
      ownerOnly: false,
    },
    {
      key: "security",
      route: "/settings/security",
      icon: ShieldCheck,
      title: "الأمان",
      hint: "المصادقة الثنائية، تسجيل الخروج من كل الأجهزة، وحذف المتجر.",
      ownerOnly: false,
    },
    {
      key: "receipt",
      route: "",
      icon: Receipt,
      title: "تخصيص الفاتورة",
      hint: "مظهر ولغة الإيصال المطبوع — كل فرع له إعداداته المستقلة.",
      ownerOnly: true,
      soon: true,
    },
  ];

  const visible = tiles.filter((t) => !t.ownerOnly || isOwner);

  return (
    <Screen title="الإعدادات">
      <Card>
        <Text numberOfLines={1} style={styles.store}>
          {me?.tenant.name ?? me?.tenant.slug ?? "—"}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {me?.tenant.slug} · الفرع الحالي: {me?.branch.name ?? "—"}
        </Text>
      </Card>

      <View style={styles.list}>
        {visible.map((tile) => {
          const Icon = tile.icon;
          const body = (
            <>
              <Icon size={20} color={colors.textSecondary} />
              <View style={styles.tileBody}>
                <View style={styles.tileTitleRow}>
                  <Text numberOfLines={1} style={styles.tileTitle}>
                    {tile.title}
                  </Text>
                  {tile.key === "branches" ? (
                    <Badge
                      label={`${branchCount} ${branchCount === 1 ? "فرع" : "فروع"}`}
                    />
                  ) : null}
                  {tile.soon ? <Badge label="قريباً" variant="lowstock" /> : null}
                </View>
                <Text style={styles.tileHint}>{tile.hint}</Text>
              </View>
              {/* CaretLeft, not Right: under RTL "forward" points left. */}
              {tile.soon ? null : (
                <CaretLeft size={20} color={colors.textSecondary} />
              )}
            </>
          );

          if (tile.soon) {
            return (
              <View key={tile.key} style={[styles.tile, styles.tileSoon]}>
                {body}
              </View>
            );
          }

          return (
            <Pressable
              key={tile.key}
              accessibilityRole="button"
              onPress={() => router.push(tile.route as never)}
              style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
            >
              {body}
            </Pressable>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  store: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  meta: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
    ...RTL_TEXT,
  },
  list: { gap: spacing.md },
  tile: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + spacing.xl,
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    ...elevation.card,
  },
  // The web's hover is `border-accent`; on native that reads as the pressed state.
  tilePressed: { borderColor: colors.accent },
  tileSoon: { opacity: 0.6 },
  tileBody: { flex: 1, minWidth: 0, gap: 2 },
  tileTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  tileTitle: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
    flexShrink: 1,
    ...RTL_TEXT,
  },
  tileHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
});
