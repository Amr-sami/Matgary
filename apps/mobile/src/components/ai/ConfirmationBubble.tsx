import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { ai, ApiError } from "@matgary/api-client";

import { api } from "@/api/client";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * ConfirmationBubble — F5 preview → execute surface.
 *
 * Tapping "Confirm" POSTs to /api/ai/confirm with the token the agent stashed
 * server-side. The server owns the action parameters; the client supplies
 * ONLY the token. On success/failure we hand the returned blocks back up to
 * the chat screen via `onResult`, which appends them as a new assistant turn.
 *
 * The expiry countdown is purely informational — the server also enforces it.
 */
export interface ConfirmationBubbleProps {
  block: ai.ConfirmationBlock;
  /** F6 — passed to the server so it can update the per-conversation context
   *  with the verified post-write state. */
  conversationId?: string;
  /** Called with the new assistant blocks on execute (success or failure).
   *  Called with null when the user cancels. */
  onResult: (blocks: ai.AiBlock[] | null) => void;
}

export function ConfirmationBubble({ block, conversationId, onResult }: ConfirmationBubbleProps) {
  const [settled, setSettled] = useState<"confirmed" | "cancelled" | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const expiresAtMs = useRef(Date.parse(block.expiresAt)).current;
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
  );
  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAtMs, settled]);
  const expired = secondsLeft <= 0;

  const execute = useMutation({
    // Confirm is NOT idempotent — the token is HMAC-signed single-use. A
    // retry would race against the atomic `consumedAt` guard, surface a
    // confusing error, and risk emitting a second visible assistant turn.
    retry: 0,
    mutationFn: () => ai.confirm(api, block.token, conversationId),
    onSuccess: (res) => {
      setSettled("confirmed");
      onResult(res.blocks);
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : null;
      setErrorText(messageFor(code));
      setSettled("confirmed"); // UX: disable the buttons; retry starts a new preview.
      // Don't swallow the error completely — let chat screen know something happened.
      onResult(null);
    },
  });

  const onCancel = () => {
    setSettled("cancelled");
    onResult(null);
  };

  return (
    <View style={[styles.card, settled && styles.cardMuted]}>
      <Text style={styles.title}>{block.title}</Text>
      <Text style={styles.summary}>{block.summary}</Text>
      {!settled && !expired ? (
        <View style={styles.actions}>
          <Pressable
            onPress={() => execute.mutate()}
            disabled={execute.isPending}
            accessibilityRole="button"
            accessibilityLabel={block.actionLabel}
            style={({ pressed }) => [
              styles.confirmBtn,
              pressed && styles.confirmBtnPressed,
              execute.isPending && styles.btnDisabled,
            ]}
          >
            {execute.isPending ? (
              <ActivityIndicator color={colors.onAccent} size="small" />
            ) : (
              <Text style={styles.confirmText}>{block.actionLabel}</Text>
            )}
          </Pressable>
          <Pressable
            onPress={onCancel}
            disabled={execute.isPending}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.cancelBtn,
              pressed && styles.cancelBtnPressed,
              execute.isPending && styles.btnDisabled,
            ]}
          >
            <Text style={styles.cancelText}>{t("app.common.cancel")}</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.footerRow}>
        {settled === "cancelled" ? (
          <Text style={styles.statusCancelled}>{t("mobile.insights.ai.confirm.cancelled")}</Text>
        ) : settled === "confirmed" ? (
          <Text style={styles.statusDone}>{t("mobile.insights.ai.confirm.sent")}</Text>
        ) : expired ? (
          <Text style={styles.statusExpired}>{t("mobile.insights.ai.confirm.expired")}</Text>
        ) : (
          <Text style={styles.countdown}>
            {t("mobile.insights.ai.confirm.expiresIn", {
              m: Math.floor(secondsLeft / 60),
              s: (secondsLeft % 60).toString().padStart(2, "0"),
            })}
          </Text>
        )}
      </View>
      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
    </View>
  );
}

function messageFor(code: string | null): string {
  if (code === "CONFIRMATION_REJECTED") return t("mobile.insights.ai.confirm.rejected");
  if (code === "BRANCH_MISMATCH") return t("mobile.insights.ai.confirm.branchMismatch");
  if (code === "FORBIDDEN") return t("mobile.insights.ai.confirm.forbidden");
  return t("mobile.insights.ai.errorFailed");
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: spacing.sm,
  },
  cardMuted: { opacity: 0.85 },
  title: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.text,
  },
  summary: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
  },
  confirmBtnPressed: { opacity: 0.85 },
  confirmText: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 14, color: colors.onAccent },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
  },
  cancelBtnPressed: { opacity: 0.7 },
  cancelText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  btnDisabled: { opacity: 0.5 },
  footerRow: { flexDirection: "row", justifyContent: "flex-end" },
  countdown: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  statusCancelled: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary },
  statusDone: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 11, color: colors.successStrong },
  statusExpired: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 11, color: colors.danger },
  errorText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.danger,
  },
});
