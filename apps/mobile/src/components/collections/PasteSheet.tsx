import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { collectionCredits } from "@matgary/api-client";

import { api } from "@/api/client";
import { accountsForMethod } from "@/collections/checkout";
import { newIdempotencyKey, useCollectionAccounts } from "@/collections/queries";
import { PASTE_MAX_CHARS, pasteOutcome } from "@/collections/rules";
import { AccountPicker } from "@/components/collections/AccountPicker";
import { collectionErrorText } from "@/components/collections/useCollectionDecisions";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { useOffline } from "@/stores/offline";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

export type PasteDone = ReturnType<typeof pasteOutcome>;

/**
 * "Paste a message" (doc 15 spec 08 §4.11, M2): the bank or wallet message
 * as it is (several are fine), an optional receiving account
 * (`credits-paste-account-<id>`; tap the picked row again to clear it — no
 * account = the server routes it from the message), and
 * `credits-paste-submit` → `POST collections/credits/paste`. A pasted credit
 * is always held `manual_source`: it never auto-confirms. The
 * Idempotency-Key is minted when the sheet mounts (the caller remounts it on
 * every opening) and reused for every retry inside it. Online only.
 *
 * On success the sheet closes and `onDone` gets the outcome; the caller
 * shows the notice and the list refetches (`["collection-credits"]`).
 */
export function PasteSheet({
  visible,
  onClose,
  onDone,
}: {
  visible: boolean;
  onClose: () => void;
  onDone: (outcome: PasteDone) => void;
}) {
  const qc = useQueryClient();
  const online = useOffline((s) => s.online);
  const accountsQ = useCollectionAccounts(visible);
  // Every active digital account of the branch: InstaPay rail first, then wallets.
  const accounts = accountsForMethod("instapay", accountsQ.accounts, accountsQ.branchId);
  const [key] = useState(newIdempotencyKey);
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);

  const paste = useMutation({
    mutationFn: () =>
      collectionCredits.pasteCredits(api, { text, accountId: accountId ?? undefined }, key),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["collection-credits"] });
      void qc.invalidateQueries({ queryKey: ["collection-summary"] });
      onDone(pasteOutcome(res.results));
    },
  });

  const empty = text.trim().length === 0;
  return (
    <Sheet
      visible={visible}
      onClose={() => {
        if (paste.isPending) return;
        onClose();
      }}
      title={t("app.collections.credits.pasteSheet.title")}
      subtitle={t("app.collections.credits.pasteSheet.hint")}
      testID="credits-paste-sheet"
      primaryAction={{
        label: t("app.collections.credits.pasteSheet.submit"),
        onPress: () => {
          if (!online || empty) return;
          paste.mutate();
        },
        loading: paste.isPending,
        disabled: !online || empty || paste.isPending,
        testID: "credits-paste-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: paste.isPending }}
    >
      <Field
        label={t("app.collections.credits.pasteSheet.title")}
        value={text}
        onChangeText={(v) => setText(v.slice(0, PASTE_MAX_CHARS))}
        multiline
        numberOfLines={6}
        maxLength={PASTE_MAX_CHARS}
        autoCorrect={false}
        autoCapitalize="none"
        textAlignVertical="top"
        testID="credits-paste-text"
      />
      {accounts.length > 0 ? (
        <View style={styles.gap}>
          <Text style={styles.label}>{t("app.collections.credits.pasteSheet.account")}</Text>
          <AccountPicker
            accounts={accounts}
            value={accountId}
            onChange={(id) => setAccountId((prev) => (prev === id ? null : id))}
            testIDPrefix="credits-paste-account-"
          />
        </View>
      ) : null}
      {!online ? <Text style={styles.hint}>{t("app.collections.detail.onlineOnly")}</Text> : null}
      {paste.isError ? (
        <Text style={styles.error} testID="credits-paste-error">
          {collectionErrorText(paste.error)}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.sm },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
});
