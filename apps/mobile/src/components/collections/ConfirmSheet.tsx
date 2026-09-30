import { StyleSheet, Text, View } from "react-native";
import type { collections } from "@matgary/api-client";

import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * "Check your bank or wallet app first" (doc 15 spec 08 §4.8, R6): names the
 * account and the amount to look for, and repeats that a customer's
 * screenshot is not proof. The opening button stays `collection-confirm`;
 * this sheet's submit is `collection-confirm-submit` (15's ARCH CR 1).
 */
export function ConfirmSheet({
  collection,
  busy,
  error,
  disabled = false,
  footnote,
  onClose,
  onSubmit,
}: {
  collection: collections.CollectionDTO | null;
  busy: boolean;
  error: string | null;
  /** Offline: decisions are never queued (03 §C.5). */
  disabled?: boolean;
  footnote?: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const account = collection?.account?.label ?? t("app.collections.inbox.row.noAccount");
  return (
    <Sheet
      visible={Boolean(collection)}
      onClose={onClose}
      title={t("app.collections.detail.confirmSheet.title")}
      testID="collection-confirm-sheet"
      primaryAction={{
        label: t("app.collections.detail.confirmSheet.submit"),
        onPress: onSubmit,
        loading: busy,
        disabled: disabled || busy,
        testID: "collection-confirm-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: busy }}
    >
      {collection ? (
        <View style={styles.body}>
          <Text style={styles.amount}>{money(collection.amount)}</Text>
          <Text style={styles.text}>
            {t("app.collections.detail.confirmSheet.check", { account, amount: money(collection.amount) })}
          </Text>
          <View style={styles.warnBox}>
            <Text style={styles.warn}>{t("app.collections.detail.confirmSheet.noScreenshot")}</Text>
          </View>
          {footnote ? <Text style={styles.hint}>{footnote}</Text> : null}
          {error ? (
            <Text style={styles.error} testID="collection-decision-error">
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  amount: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 24, color: colors.text, fontVariant: ["tabular-nums"] },
  text: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 15, color: colors.text, lineHeight: 24 },
  warnBox: { borderRadius: radius.md, backgroundColor: colors.warningLight, padding: spacing.md },
  warn: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.warningStrong },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
});
