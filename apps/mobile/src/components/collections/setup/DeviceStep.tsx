import { StyleSheet, Text, View } from "react-native";
import type { collections } from "@matgary/api-client";

import { Field } from "@/components/ui/Field";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

type Account = collections.CollectionAccountDTO;

/**
 * The `device` step body (doc 15 spec 09 §4.6.2): the phone's label (default
 * `{name} — {model}`, ≤ 60) and the account scope. "All accounts" is the
 * default and sends `accountIds: []`; turning it off lists each active
 * account (`collection-device-account-<id>`). The create button is the
 * frame's primary action (`device.create`).
 */
export function DeviceStep({
  label,
  onLabel,
  accounts,
  allAccounts,
  onAllAccounts,
  selected,
  onToggle,
  error,
}: {
  label: string;
  onLabel: (v: string) => void;
  accounts: Account[];
  allAccounts: boolean;
  onAllAccounts: (v: boolean) => void;
  selected: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  error?: string | null;
}) {
  return (
    <View style={styles.gap}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t("mobile.collections.setup.device.heading")}
      </Text>
      <Field
        testID="collection-device-label"
        label={t("mobile.collections.setup.device.label")}
        value={label}
        onChangeText={onLabel}
        maxLength={60}
      />
      <Text style={styles.hint}>{t("mobile.collections.setup.device.labelHint")}</Text>
      <Text style={styles.sub}>{t("mobile.collections.setup.device.accounts")}</Text>
      <ToggleRow
        testID="collection-device-account-all"
        label={t("mobile.collections.setup.device.allAccounts")}
        value={allAccounts}
        onValueChange={onAllAccounts}
      />
      {allAccounts
        ? null
        : accounts.map((a) => (
            <ToggleRow
              key={a.id}
              testID={`collection-device-account-${a.id}`}
              label={a.label}
              hint={t(`app.collections.vocab.providers.${a.provider}`)}
              value={selected.includes(a.id)}
              onValueChange={(v) => onToggle(a.id, v)}
            />
          ))}
      {error ? (
        <Text style={styles.error} testID="collection-device-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.md },
  heading: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 18, color: colors.text },
  sub: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.text, marginTop: spacing.sm },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, lineHeight: 22, color: colors.danger },
});
