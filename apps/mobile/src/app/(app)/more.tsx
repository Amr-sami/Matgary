import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { BellIcon as Bell } from "phosphor-react-native/src/icons/Bell";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "phosphor-react-native/src/icons/ClockCounterClockwise";
import { CloudArrowUpIcon as CloudArrowUp } from "phosphor-react-native/src/icons/CloudArrowUp";
import { CreditCardIcon as CreditCard } from "phosphor-react-native/src/icons/CreditCard";
import { GearIcon as Gear } from "phosphor-react-native/src/icons/Gear";
import { ListChecksIcon as ListChecks } from "phosphor-react-native/src/icons/ListChecks";
import { MapPinAreaIcon as MapPinArea } from "phosphor-react-native/src/icons/MapPinArea";
import { SignOutIcon as SignOut } from "phosphor-react-native/src/icons/SignOut";
import { StorefrontIcon as Storefront } from "phosphor-react-native/src/icons/Storefront";
import { TruckIcon as Truck } from "phosphor-react-native/src/icons/Truck";
import { UsersIcon as Users } from "phosphor-react-native/src/icons/Users";
import { UsersThreeIcon as UsersThree } from "phosphor-react-native/src/icons/UsersThree";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import { WhatsappLogoIcon as WhatsappLogo } from "phosphor-react-native/src/icons/WhatsappLogo";

import { Screen } from "@/components/layout/Screen";
import { ChevronForward } from "@/components/ui/Chevron";
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
const ITEMS = () =>
  ([
  { route: "/tasks", label: t("app.shell.secondary.tasks"), icon: ListChecks, requires: "view_dashboard" },
  { route: "/attendance", label: t("mobile.attendance.title"), icon: MapPinArea, requires: null },
  { route: "/sync", label: t("mobile.sync.title"), icon: CloudArrowUp, requires: "create_sale" },
  { route: "/notifications", label: t("mobile.notifications.title"), icon: Bell, requires: null },
  { route: "/customers", label: t("app.shell.secondary.customers"), icon: Users, requires: "view_customers" },
  { route: "/expenses", label: t("app.shell.secondary.expenses"), icon: Wallet, requires: "view_expenses" },
  { route: "/suppliers", label: t("app.shell.secondary.suppliers"), icon: Truck, requires: "view_suppliers" },
  { route: "/returns", label: t("app.shell.secondary.returns"), icon: ArrowCounterClockwise, requires: "view_returns" },
  { route: "/team", label: t("app.shell.secondary.team"), icon: UsersThree, requires: "manage_team" },
  { route: "/activity", label: t("app.shell.secondary.activity"), icon: ClockCounterClockwise, requires: "view_activity_log" },
  { route: "/leave", label: t("mobile.leave.title"), icon: CalendarBlank, requires: "request_leave" },
  { route: "/whatsapp", label: t("app.whatsappInbox.title"), icon: WhatsappLogo, requires: "manage_whatsapp" },
  { route: "/settings", label: t("app.shell.secondary.settings"), icon: Gear, requires: "view_settings" },
  { route: "/billing", label: t("app.billing.title"), icon: CreditCard, requires: null },
] as const);

const TEAM_ANY = ["manage_team", "request_leave", "manage_leave"];

export default function MoreScreen() {
  const router = useRouter();
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const allowed = new Set(me?.permissions ?? []);
  // The onboarding wizard is a soft gate (web: OnboardingReminder banner,
  // never a redirect) and /onboarding is otherwise only reached from signup.
  // Until the tenant's Finish/Skip has run this row is the way back to it —
  // after a kill, a lost connection, or a step-2 tip that left the wizard.
  // Strict `=== false`: an older server omits the flag, and then there is
  // nothing to finish. Same audience as the web banner: any member.
  const showFinishSetup = me?.onboardingComplete === false;

  const visible = ITEMS().filter((i) => {
    if (i.route === "/tasks") return Boolean(me);
    if (i.route === "/team") return TEAM_ANY.some((p) => allowed.has(p));
    if (i.route === "/leave") return allowed.has("request_leave") || allowed.has("manage_leave");
    // Billing is owner-only on the web (app.billing.ownerOnly).
    if (i.route === "/billing") return Boolean(me?.isOwner);
    // `requires: null` = any signed-in member (attendance, notifications).
    return i.requires === null ? Boolean(me) : allowed.has(i.requires);
  });

  return (
    <Screen title={t("app.shell.more")}>
      <Card>
        <Text style={styles.account}>{me?.user.name ?? me?.user.email}</Text>
        <Text style={styles.accountMeta}>
          {me?.tenant.name} · {me?.branch.name}
        </Text>
      </Card>

      {showFinishSetup && (
        <Pressable
          style={[styles.row, styles.setup]}
          accessibilityRole="button"
          onPress={() => router.push("/onboarding" as never)}
        >
          <Storefront size={22} color={colors.accent} weight="fill" />
          <Text style={styles.rowLabel}>{t("auth.onboarding.reminder.cta")}</Text>
          <ChevronForward size={16} color={colors.accent} />
        </Pressable>
      )}

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
              {/* not Right: under RTL "forward" points left. */}
              <ChevronForward size={16} color={colors.textSecondary} />
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
  setup: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  signOut: { marginTop: spacing.lg, borderColor: colors.dangerLight },
  signOutLabel: { color: colors.danger, flex: 1 },
});
