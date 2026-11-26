import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { CircleIcon as Circle } from "phosphor-react-native/src/icons/Circle";
import type { collections } from "@matgary/api-client";

import { accountIdentity } from "@/collections/checkout";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Account = collections.CollectionAccountDTO;

/** R13: a long list would push the record button far down; 4 rows, then "show all". */
const COLLAPSED_ROWS = 4;

/**
 * Radio list of receiving accounts (doc 15 spec 08 §4.2 item 3, §4.13). Each
 * row: label, provider name, identity (IPA handle / wallet number / •••• last
 * 4 — never an IBAN), a POS-default marker, the check on the active row.
 * Rows are `${testIDPrefix}${accountId}`: `pos-collection-account-`,
 * `pos-collection-part-<n>-account-`, `settle-collection-account-`,
 * `credits-paste-account-`.
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
  testIDPrefix,
  disabled = false,
}: {
  accounts: readonly Account[];
  value: string | null;
  onChange: (id: string) => void;
  testIDPrefix: string;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // The picked row always stays visible, even when it sorts past the cut.
  const pickedIndex = accounts.findIndex((a) => a.id === value);
  const collapsed = !expanded && accounts.length > COLLAPSED_ROWS + 1;
  const shown = collapsed
    ? accounts.filter((_, i) => i < COLLAPSED_ROWS || i === pickedIndex)
    : accounts;
  return (
    <View style={styles.list} accessibilityRole="radiogroup">
      {shown.map((a) => {
        const active = a.id === value;
        const identity = accountIdentity(a);
        return (
          <Pressable
            key={a.id}
            testID={`${testIDPrefix}${a.id}`}
            disabled={disabled}
            onPress={() => onChange(a.id)}
            accessibilityRole="radio"
            accessibilityState={{ checked: active, disabled }}
            style={({ pressed }) => [
              styles.row,
              active && styles.rowActive,
              pressed && !active && styles.rowPressed,
              disabled && styles.rowDisabled,
            ]}
          >
            {active ? (
              <CheckCircle size={22} color={colors.accent} weight="fill" />
            ) : (
              <Circle size={22} color={colors.border} />
            )}
            <View style={styles.text}>
              <View style={styles.titleRow}>
                <Text numberOfLines={1} style={styles.label}>
                  {a.label}
                </Text>
                {a.isPosDefault ? <Text style={styles.default}>{t("app.collections.pos.posDefault")}</Text> : null}
              </View>
              <Text numberOfLines={1} style={styles.meta}>
                {t(`app.collections.vocab.providers.${a.provider}`)}
                {identity ? " · " : ""}
                {identity ? <Text style={styles.ltr}>{`⁦${identity}⁩`}</Text> : null}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {collapsed ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          style={styles.more}
          testID={`${testIDPrefix}show-all`}
        >
          <Text style={styles.moreText}>{t("app.collections.pos.showAllAccounts", { n: accounts.length })}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  rowActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  rowPressed: { backgroundColor: colors.neutralTint },
  rowDisabled: { opacity: 0.5 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  default: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 11, color: colors.accent },
  meta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  ltr: { writingDirection: "ltr" },
  more: { minHeight: MIN_TOUCH, justifyContent: "center", alignSelf: "flex-start" },
  moreText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
});
