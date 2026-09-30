import { Pressable, StyleSheet, Text, View } from "react-native";
import type { collections } from "@matgary/api-client";

import { accountIdentity } from "@/collections/checkout";
import { Badge } from "@/components/ui/Badge";
import { ChevronForward } from "@/components/ui/Chevron";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Account = collections.CollectionAccountDTO;

/**
 * One receiving account on the collections hub (doc 15 spec 09 §4.3 item 4):
 * the label, the provider, a rail badge and the identity — the IPA handle or
 * `•••• 1234` for InstaPay, the full wallet number (LTR) for a wallet. The
 * full number is fine here: the hub is manage-only and the account is the
 * owner's own data (03 §E.3). The IBAN never appears in the row.
 *
 * Badges: all branches (`branchId == null`), checkout default, mobile-number
 * account, and — only with L2 (`showAutoConfirm`) — auto-confirm.
 */
export function AccountRow({
  account,
  onPress,
  showAutoConfirm,
}: {
  account: Account;
  onPress: () => void;
  showAutoConfirm: boolean;
}) {
  const identity = accountIdentity(account);
  return (
    <Pressable
      accessibilityRole="button"
      testID={`collection-account-${account.id}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.body}>
        <Text numberOfLines={1} style={styles.label}>
          {account.label}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {t(`app.collections.vocab.providers.${account.provider}`)}
          {identity ? " · " : ""}
          {identity ? <Text style={styles.ltr}>{`⁦${identity}⁩`}</Text> : null}
        </Text>
        <View style={styles.badges}>
          <Badge label={t(`app.collections.vocab.rails.${account.rail}`)} variant="accent" />
          {account.branchId == null ? <Badge label={t("app.collectionsSettings.accounts.badges.allBranches")} /> : null}
          {account.isPosDefault ? (
            <Badge label={t("app.collectionsSettings.accounts.badges.posDefault")} variant="success" />
          ) : null}
          {account.rail === "instapay" && account.isDefaultForMobile ? (
            <Badge label={t("app.collectionsSettings.accounts.badges.mobileDefault")} />
          ) : null}
          {showAutoConfirm && account.autoConfirmEnabled ? (
            <Badge label={t("app.collectionsSettings.accounts.badges.autoConfirm")} variant="lowstock" />
          ) : null}
        </View>
      </View>
      {/* not Right: under RTL "forward" points left. */}
      <ChevronForward size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + spacing.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  rowPressed: { borderColor: colors.accent, backgroundColor: colors.neutralTint },
  body: { flex: 1, minWidth: 0, gap: 4 },
  label: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  meta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  ltr: { writingDirection: "ltr" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: 2 },
});
