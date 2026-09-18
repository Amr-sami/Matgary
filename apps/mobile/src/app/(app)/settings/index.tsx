import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { BellIcon as Bell } from "phosphor-react-native/src/icons/Bell";
import { ChatCircleIcon as ChatCircle } from "phosphor-react-native/src/icons/ChatCircle";
import { IdentificationCardIcon as IdentificationCard } from "phosphor-react-native/src/icons/IdentificationCard";
import { InfoIcon as Info } from "phosphor-react-native/src/icons/Info";
import { KeyIcon as Key } from "phosphor-react-native/src/icons/Key";
import { LockKeyIcon as LockKey } from "phosphor-react-native/src/icons/LockKey";
import { PrinterIcon as Printer } from "phosphor-react-native/src/icons/Printer";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";
import { ShieldCheckIcon as ShieldCheck } from "phosphor-react-native/src/icons/ShieldCheck";
import { SlidersHorizontalIcon as SlidersHorizontal } from "phosphor-react-native/src/icons/SlidersHorizontal";
import { SquaresFourIcon as SquaresFour } from "phosphor-react-native/src/icons/SquaresFour";
import { StorefrontIcon as Storefront } from "phosphor-react-native/src/icons/Storefront";
import { TagIcon as Tag } from "phosphor-react-native/src/icons/Tag";

import { Screen } from "@/components/layout/Screen";
import { ChevronForward } from "@/components/ui/Chevron";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t, useLocale } from "@/i18n";

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
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const isOwner = me?.isOwner ?? false;
  const branchCount = me?.branches.length ?? 0;

  const tiles: Tile[] = [
    {
      key: "branches",
      route: "/settings/branches",
      icon: Storefront,
      title: t("app.settingsPage.branches.title"),
      hint:
        branchCount <= 1
          ? t("app.settingsPage.branches.hintOne")
          : t("app.settingsPage.branches.hintMany"),
      ownerOnly: true,
    },
    {
      key: "digest",
      route: "/settings/digest",
      icon: ChatCircle,
      title: t("app.digestSettings.title"),
      hint: t("app.settingsPage.digestTile.subtitle"),
      ownerOnly: true,
    },
    {
      key: "notifications",
      route: "/settings/notifications",
      icon: Bell,
      title: t("app.notificationSettings.title"),
      hint: t("app.settingsPage.notificationsTile.subtitle"),
      ownerOnly: false,
    },
    {
      key: "security",
      route: "/settings/security",
      icon: ShieldCheck,
      title: t("app.accountSecurity.title"),
      hint: t("mobile.settings.securitySub"),
      ownerOnly: false,
    },
    {
      key: "changePassword",
      route: "/settings/change-password",
      icon: Key,
      title: t("app.changePassword.title"),
      hint: t("mobile.settings.changePasswordSub"),
      ownerOnly: false,
    },
    {
      key: "store",
      route: "/settings/store",
      icon: IdentificationCard,
      title: t("app.settingsPage.shopInfo.section"),
      hint: t("mobile.settings.storeSub"),
      ownerOnly: true,
    },
    {
      key: "categories",
      route: "/settings/categories",
      icon: SquaresFour,
      title: t("mobile.settings.categories"),
      hint: t("mobile.settings.categoriesSub"),
      ownerOnly: false,
    },
    {
      key: "brands",
      route: "/settings/brands",
      icon: Tag,
      title: t("mobile.settings.brands"),
      hint: t("mobile.settings.brandsSub"),
      ownerOnly: false,
    },
    {
      key: "attributes",
      route: "/settings/attributes",
      icon: SlidersHorizontal,
      title: t("mobile.settings.attributes"),
      hint: t("mobile.settings.attributesSub"),
      ownerOnly: false,
    },
    {
      key: "receipt",
      route: "/settings/receipt",
      icon: Receipt,
      title: t("app.settingsPage.receiptCard.heading"),
      hint: t("app.settingsPage.receiptCard.subhead"),
      ownerOnly: true,
    },
    {
      key: "printers",
      route: "/settings/printers",
      icon: Printer,
      title: t("mobile.settings.printers"),
      hint: t("mobile.settings.printersSub"),
      ownerOnly: false,
    },
    {
      key: "app-lock",
      route: "/settings/app-lock",
      icon: LockKey,
      title: t("mobile.settings.appLock"),
      hint: t("mobile.settings.appLockSub"),
      ownerOnly: false,
    },
    {
      key: "about",
      route: "/settings/about",
      icon: Info,
      title: t("mobile.settings.about"),
      hint: t("mobile.settings.aboutSub"),
      ownerOnly: false,
    },
  ];

  const visible = tiles.filter((t) => !t.ownerOnly || isOwner);

  return (
    <Screen title={t("app.settingsPage.title")}>
      <Card>
        <Text numberOfLines={1} style={styles.store}>
          {me?.tenant.name ?? me?.tenant.slug ?? "—"}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {t("mobile.settings.currentBranchLine", { slug: me?.tenant.slug ?? "", branch: me?.branch.name ?? "—" })}
        </Text>
      </Card>

      {/* Language. The web puts this in the user menu; on the phone Settings is
          where a person looks for it. Same two labels the web uses. */}
      <Card title={t("app.shell.language.label")}>
        <Segmented
          value={locale}
          onChange={(v) => void setLocale(v)}
          items={[
            { key: "ar", label: t("app.shell.language.arabic") },
            { key: "en", label: t("app.shell.language.english") },
          ]}
        />
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
                  {/* Bare count: the title already names the noun, and a digit
                      needs no Arabic dual/plural agreement ("2 فروع" was wrong). */}
                  {tile.key === "branches" ? <Badge label={String(branchCount)} /> : null}
                  {tile.soon ? <Badge label={t("app.billing.comingSoon")} variant="lowstock" /> : null}
                </View>
                <Text style={styles.tileHint}>{tile.hint}</Text>
              </View>
              {/* not Right: under RTL "forward" points left. */}
              {tile.soon ? null : (
                <ChevronForward size={20} color={colors.textSecondary} />
              )}
            </>
          );

          if (tile.soon) {
            return (
              <View key={tile.key} style={[styles.tile, styles.tileSoon]} testID={`settings-tile-${tile.key}`}>
                {body}
              </View>
            );
          }

          return (
            <Pressable
              key={tile.key}
              accessibilityRole="button"
              testID={`settings-tile-${tile.key}`}
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
  list: { gap: spacing.lg },
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
