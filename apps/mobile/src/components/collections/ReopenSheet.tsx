import { StyleSheet, Text, View } from "react-native";
import type { collections } from "@matgary/api-client";

import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/** Owner only, ≤ 7 days (doc 15 spec 08 §4.8): back to awaiting; any debt it created is undone. */
export function ReopenSheet({
  collection,
  busy,
  error,
  disabled = false,
  onClose,
  onSubmit,
}: {
  collection: collections.CollectionDTO | null;
  busy: boolean;
  error: string | null;
  disabled?: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Sheet
      visible={Boolean(collection)}
      onClose={onClose}
      title={t("app.collections.detail.reopenSheet.title")}
      testID="collection-reopen-sheet"
      primaryAction={{
        label: t("app.collections.detail.reopenSheet.submit"),
        onPress: onSubmit,
        loading: busy,
        disabled: disabled || busy,
        testID: "collection-reopen-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: busy }}
    >
      <View style={styles.body}>
        <Text style={styles.text}>{t("app.collections.detail.reopenSheet.body")}</Text>
        {error ? (
          <Text style={styles.error} testID="collection-decision-error">
            {error}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  text: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 15, color: colors.text, lineHeight: 24 },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
});
