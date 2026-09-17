import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  ArrowCounterClockwise,
  CaretLeft,
  CreditCard,
  Gear,
  ListChecks,
  SignOut,
  Truck,
  UsersThree,
  Users,
  Wallet,
} from "phosphor-react-native";

import { Screen } from "@/components/layout/Screen";
import { Card } from "@/components/ui/Card";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of states/more-sheet.png — the secondary destinations the six-tab bar
 * cannot hold, plus the account block.
 *
 * Same seven entries and the same permission rules as the web's moreItems,
 * including its two exceptions: tasks needs only a session, and team is shown
 * for ANY of manage_team / request_leave / manage_leave, so a staff member who
 * can only request leave still reaches it.
 */
const ITEMS = [
  { route: "/tasks", label: t("app.shell.secondary.tasks"), icon: ListChecks, requires: "view_dashboard" },
  { route: "/customers", label: t("app.shell.secondary.customers"), icon: Users, requires: "view_customers" },
  { route: "/expenses", label: t("app.shell.secondary.expenses"), icon: Wallet, requires: "view_expenses" },
  { route: "/suppliers", label: t("app.shell.secondary.suppliers"), icon: Truck, requires: "view_suppliers" },
  { route: "/returns", label: t("app.shell.secondary.returns"), icon: ArrowCounterClockwise, requires: "view_returns" },
  { route: "/team", label: t("app.shell.secondary.team"), icon: UsersThree, requires: "manage_team" },
  { route: "/settings", label: t("app.shell.secondary.settings"), icon: Gear, requires: "view_settings" },
  { route: "/billing", label: t("app.billing.title"), icon: CreditCard, requires: null },
] as const;

const TEAM_ANY = ["manage_team", "request_leave", "manage_leave"];

export default function MoreScreen() {
  const router = useRouter();
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const allowed = new Set(me?.permissions ?? []);

  const visible = ITEMS.filter((i) => {
    if (i.route === "/tasks") return Boolean(me);
    if (i.route === "/team") return TEAM_ANY.some((p) => allowed.has(p));
    // Billing is owner-only on the web (app.billing.ownerOnly).
    if (i.route === "/billing") return Boolean(me?.isOwner);
    return allowed.has(i.requires);
  });

  return (
    <Screen title={t("app.shell.more")}>
      <Card>
        <Text style={styles.account}>{me?.user.name ?? me?.user.email}</Text>
        <Text style={styles.accountMeta}>
          {me?.tenant.name} · {me?.branch.name}
        </Text>
      </Card>

      <View style={styles.list}>
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <Pressable
              key={item.route}
              style={styles.row}
              accessibilityRole="button"
              onPress={() => router.push(item.route as never)}
            >
              <Icon size={22} color={colors.accent} />
              <Text style={styles.rowLabel}>{item.label}</Text>
              {/* CaretLeft, not Right: under RTL "forward" points left. */}
              <CaretLeft size={16} color={colors.textSecondary} />
            </Pressable>
          );
        })}
      </View>

      <Pressable
        style={[styles.row, styles.signOut]}
        accessibilityRole="button"
        onPress={() => void signOut()}
      >
        <SignOut size={22} color={colors.danger} />
        <Text style={[styles.rowLabel, styles.signOutLabel]}>{t("app.shell.userMenu.signOut")}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  account: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  accountMeta: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
    ...RTL_TEXT,
  },
  list: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  rowLabel: { flex: 1, fontFamily: fonts.medium, fontSize: 16, color: colors.text, ...RTL_TEXT },
  signOut: { marginTop: spacing.lg, borderColor: colors.dangerLight },
  signOutLabel: { color: colors.danger, flex: 1 },
});
