import { Pressable, StyleSheet, Text, View } from "react-native";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { CircleIcon as Circle } from "phosphor-react-native/src/icons/Circle";

import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

import type { Rail } from "./account-form";
import { providersForRail } from "./account-rules";

/**
 * Pick the bank (InstaPay) or the wallet operator (doc 15 spec 09 §4.4,
 * `provider` row): the rows are 06's COLLECTION_PROVIDERS filtered by rail,
 * labelled from 05's `app.collections.vocab.providers.<id>`; each row is
 * `collection-account-form-provider-<id>`.
 */
export function ProviderSheet({
  visible,
  rail,
  value,
  onPick,
  onClose,
}: {
  visible: boolean;
  rail: Rail;
  value: string;
  onPick: (providerId: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("app.collectionsSettings.form.fields.provider.pickTitle")}
      subtitle={
        rail === "instapay"
          ? t("app.collectionsSettings.form.fields.provider.bank")
          : t("app.collectionsSettings.form.fields.provider.wallet")
      }
      testID="collection-account-form-provider-sheet"
    >
      <View style={styles.list} accessibilityRole="radiogroup">
        {providersForRail(rail).map((p) => (
          <SheetOption
            key={p.id}
            label={t(p.labelKey)}
            active={p.id === value}
            testID={`collection-account-form-provider-${p.id}`}
            onPress={() => {
              onPick(p.id);
              onClose();
            }}
          />
        ))}
      </View>
    </Sheet>
  );
}

/** One radio row inside a picker sheet. */
export function SheetOption({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && !active && styles.rowPressed]}
    >
      {active ? (
        <CheckCircle size={22} color={colors.accent} weight="fill" />
      ) : (
        <Circle size={22} color={colors.border} />
      )}
      <Text numberOfLines={2} style={styles.label}>
        {label}
      </Text>
    </Pressable>
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
  label: { ...RTL_TEXT, flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
});
