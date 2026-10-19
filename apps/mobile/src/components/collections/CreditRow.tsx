import { Pressable, StyleSheet, Text, View } from "react-native";
import type { collectionCredits } from "@matgary/api-client";

import { creditPayerText } from "@/collections/rules";
import { Badge } from "@/components/ui/Badge";
import { ChevronForward } from "@/components/ui/Chevron";
import { t } from "@/i18n";
import { money, shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Credit = collectionCredits.CreditDTO;

/** LTR isolate for an all-Latin run (invoice id, "13:41", a reference) inside Arabic. */
export function ltr(s: string): string {
  return `⁦${s}⁩`;
}

export function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One bank / wallet message that still needs a person (doc 15 spec 08 §4.11,
 * M2): amount, account, the time it happened, the payer (masked name or last
 * 4), the channels, and — for a held credit — why it is held
 * (`app.collections.vocab.holdReasons.<reason>`; at M2 every template is a
 * `published_sample`, so held reads `unverified_format` or `manual_source`,
 * never `auto_confirm_off`). A suggested sale shows "Likely: INV-…".
 * Tap → /collections/credit/<id>.
 */
export function CreditRow({ credit, onPress }: { credit: Credit; onPress: () => void }) {
  const payer = creditPayerText(credit);
  const suggested = credit.suggestedCollection;
  const meta = [shortDate(credit.occurredAt), ltr(timeOf(credit.occurredAt)), payer]
    .filter(Boolean)
    .join(" · ");
  const channels = credit.channels.map((ch) => t(`app.collections.vocab.channels.${ch}`)).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={`credit-row-${credit.id}`}
    >
      <View style={styles.main}>
        <View style={styles.top}>
          <Text style={styles.amount}>{money(credit.amount)}</Text>
          <View style={styles.badges}>
            {credit.state === "held" && credit.holdReason ? (
              <View testID={`credit-hold-${credit.holdReason}`} collapsable={false}>
                <Badge label={t(`app.collections.vocab.holdReasons.${credit.holdReason}`)} variant="lowstock" />
              </View>
            ) : (
              <Badge label={t(`app.collections.credits.states.${credit.state}`)} variant="neutral" />
            )}
          </View>
        </View>
        <Text style={styles.account} numberOfLines={1}>
          {credit.account
            ? `${credit.account.label} · ${t(`app.collections.vocab.providers.${credit.account.provider}`)}`
            : t("app.collections.inbox.row.noAccount")}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        {channels ? (
          <Text style={styles.meta} numberOfLines={1}>
            {t("app.collections.credits.channels")}: {channels}
          </Text>
        ) : null}
        {suggested?.invoiceId ? (
          <Text style={styles.suggested} numberOfLines={1}>
            {t("app.collections.credits.suggested", { invoice: ltr(suggested.invoiceId) })}
          </Text>
        ) : null}
      </View>
      <ChevronForward size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, minHeight: MIN_TOUCH },
  rowPressed: { backgroundColor: colors.accentLight, borderRadius: radius.md },
  main: { flex: 1, gap: 3 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  badges: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexShrink: 1 },
  amount: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 17, color: colors.text, fontVariant: ["tabular-nums"] },
  account: { alignSelf: "flex-start", fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  meta: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  suggested: { alignSelf: "flex-start", fontFamily: fonts.semibold, fontSize: 13, color: colors.accent, ...RTL_TEXT },
});
