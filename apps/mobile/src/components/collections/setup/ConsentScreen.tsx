import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

import { consentOrder } from "./wizard";

const NS = "mobile.collections.consent";

/**
 * The L2 prominent disclosure + consent (doc 15 spec 09 §4.6.3). It RENDERS
 * spec 14's text (`mobile.collections.consent.*`) and never writes it, in
 * 14 §4.2's binding order (`consentOrder`): title → the variant's lead,
 * reads, sends, key → common.neverSends … law → the privacy link → the
 * statement → agree / decline → the version footer. Nothing else is on the
 * screen; no timer, no auto-dismiss. Back / decline = no consent (Play: "must
 * not interpret navigation away … as consent").
 *
 * `onAgree(version)` hands 14's version string to the device POST
 * (`consentVersion`); the server stores it with the time and the user.
 */
export function ConsentScreen({
  variant,
  onAgree,
  onDecline,
  busy = false,
}: {
  variant: "ios" | "android";
  onAgree: (version: string) => void;
  onDecline: () => void;
  busy?: boolean;
}) {
  const router = useRouter();
  const key = (k: string) => `${NS}.${k}`;
  const text = (k: string) => t(`mobile.collections.consent.${k}`);
  const version = t("mobile.collections.consent.version");

  const order = consentOrder(variant);
  const body = order.filter((k) => k !== "title" && !["privacyLink", "common.statement", "agree", "decline", "versionLabel", "version"].includes(k));

  return (
    <View style={styles.root} testID="collection-consent">
      <Text accessibilityRole="header" style={styles.title}>
        {text("title")}
      </Text>
      {body.map((k) => (
        <Text key={key(k)} style={styles.para}>
          {text(k)}
        </Text>
      ))}
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push("/legal/privacy" as never)}
        hitSlop={8}
        testID="collection-consent-privacy"
      >
        <Text style={styles.link}>{text("privacyLink")}</Text>
      </Pressable>
      <Text style={styles.statement}>{text("common.statement")}</Text>
      <View style={styles.buttons}>
        <View testID="collection-consent-agree" collapsable={false}>
          <Button label={text("agree")} onPress={() => onAgree(version)} loading={busy} disabled={busy} />
        </View>
        <View testID="collection-consent-decline" collapsable={false}>
          <Button label={text("decline")} variant="outline" onPress={onDecline} disabled={busy} />
        </View>
      </View>
      <Text style={styles.version}>{`${text("versionLabel")} ${version}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 20, lineHeight: 30, color: colors.text },
  para: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 15, lineHeight: 24, color: colors.text },
  link: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, lineHeight: 24, color: colors.accent, textDecorationLine: "underline" },
  statement: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 15,
    lineHeight: 24,
    color: colors.text,
    backgroundColor: colors.accentLight,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  buttons: { gap: spacing.sm, marginTop: spacing.sm },
  version: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: colors.textSecondary },
});
