import { StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * The link code for the HTTP shortcut (doc 15 spec 09 §4.6.5 row 1): the
 * heading, the warning not to share it, a MASKED prefix (`mgi_<8>…`) and the
 * share button. The full token never renders as text; it only leaves the
 * app through the share sheet (`Share.share`, whose iOS sheet offers Copy —
 * the app has no clipboard module, and adding one would change the native
 * build M2 must not change). The caller owns the token (a `useRef`).
 */
export function TokenCard({ prefix, onShare, shared }: { prefix: string; onShare: () => void; shared: boolean }) {
  return (
    <Card>
      <View style={styles.gap}>
        <Text accessibilityRole="header" style={styles.heading}>
          {t("mobile.collections.setup.token.heading")}
        </Text>
        <Text style={styles.body}>{t("mobile.collections.setup.token.body")}</Text>
        <Text style={styles.code} testID="collection-automation-token-prefix">
          {`⁦${t("mobile.collections.setup.token.shown", { prefix })}⁩`}
        </Text>
        <View testID="collection-automation-share-token" collapsable={false}>
          <Button
            label={t("mobile.collections.setup.token.share")}
            variant={shared ? "outline" : "primary"}
            onPress={onShare}
          />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.md },
  heading: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 16, color: colors.text },
  body: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.textSecondary },
  code: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.neutralTint,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    writingDirection: "ltr",
  },
});
