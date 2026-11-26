import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { collections } from "@matgary/api-client";

import { REJECT_REASONS, defaultRejectOutcome, rejectNeedsPhone } from "@/collections/rules";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { toE164 } from "@/lib/customer-phone";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

type Reason = collections.RejectReason;
type Outcome = collections.RejectOutcome;

const NOTE_MAX = 280;

/**
 * "Transfer not received" (doc 15 spec 08 §4.8, Q4). Reason chips (none
 * preselected, required); the outcome defaults to debt when the sale knows
 * the customer's phone, else loss, and is fixed to debt for a settlement;
 * debt without a phone asks for one (validated like every other phone field,
 * lib/customer-phone toE164); an optional note ≤ 280.
 */
export function RejectSheet({
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
  disabled?: boolean;
  footnote?: string | null;
  onClose: () => void;
  onSubmit: (body: collections.RejectCollectionBody) => void;
}) {
  // Fresh per collection: the caller keys this component by the collection
  // id, so a sheet reopened for another transfer starts clean.
  const [reason, setReason] = useState<Reason | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(() => (collection ? defaultRejectOutcome(collection) : "loss"));
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");

  const settlement = collection?.sourceType === "settlement";
  const needsPhone = collection ? rejectNeedsPhone(collection, outcome) : false;
  const e164 = toE164(phone);
  const phoneBad = needsPhone && phone.trim() !== "" && !e164;
  const ready = reason !== null && (!needsPhone || e164 !== null);
  const recorder = collection?.recordedBy?.name?.trim();

  return (
    <Sheet
      visible={Boolean(collection)}
      onClose={onClose}
      title={t("app.collections.detail.rejectSheet.title")}
      subtitle={collection ? money(collection.amount) : undefined}
      testID="collection-reject-sheet"
      primaryAction={{
        label: t("app.collections.detail.rejectSheet.submit"),
        onPress: () => {
          if (!reason) return;
          onSubmit({
            reason,
            outcome: settlement ? "debt" : outcome,
            ...(needsPhone && e164 ? { customerPhone: e164 } : {}),
            ...(note.trim() ? { note: note.trim().slice(0, NOTE_MAX) } : {}),
          });
        },
        loading: busy,
        disabled: disabled || busy || !ready,
        destructive: true,
        testID: "collection-reject-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: busy }}
    >
      {collection ? (
        <View style={styles.body}>
          <Text style={styles.label}>{t("app.collections.detail.rejectSheet.reason")}</Text>
          <View style={styles.chips}>
            {REJECT_REASONS.map((r) => (
              <Chip
                key={r}
                label={t(`app.collections.vocab.reasons.${r}`)}
                active={reason === r}
                onPress={() => setReason(r)}
                testID={`collection-reject-reason-${r}`}
              />
            ))}
          </View>

          <Text style={styles.label}>{t("app.collections.detail.rejectSheet.outcome")}</Text>
          {settlement ? (
            <Text style={styles.hint}>{t("app.collections.detail.rejectSheet.settlementHint")}</Text>
          ) : (
            <>
              <View style={styles.chips}>
                {(["debt", "loss"] as const).map((o) => (
                  <Chip
                    key={o}
                    label={t(`app.collections.vocab.outcomes.${o}`)}
                    active={outcome === o}
                    onPress={() => setOutcome(o)}
                    testID={`collection-reject-outcome-${o}`}
                  />
                ))}
              </View>
              <Text style={styles.hint}>
                {outcome === "debt"
                  ? t("app.collections.detail.rejectSheet.debtHint")
                  : recorder
                    ? t("app.collections.detail.rejectSheet.lossHint", { name: recorder })
                    : t("app.collections.detail.rejectSheet.lossHintUnknown")}
              </Text>
            </>
          )}

          {needsPhone ? (
            <View style={styles.gap}>
              <Field
                label={t("app.collections.detail.rejectSheet.phone")}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                ltr
                testID="collection-reject-phone"
              />
              {phone.trim() === "" || phoneBad ? (
                <Text style={phoneBad ? styles.error : styles.hint}>
                  {phoneBad ? t("app.collections.errors.INVALID_PHONE") : t("app.collections.detail.rejectSheet.phoneRequired")}
                </Text>
              ) : null}
            </View>
          ) : null}

          <Field
            label={t("app.collections.detail.rejectSheet.note")}
            value={note}
            onChangeText={(v) => setNote(v.slice(0, NOTE_MAX))}
            multiline
            maxLength={NOTE_MAX}
            testID="collection-reject-note"
          />
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
  gap: { gap: spacing.xs },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
});
