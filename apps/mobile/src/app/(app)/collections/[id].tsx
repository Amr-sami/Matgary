import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ApiError, collections } from "@matgary/api-client";

import { api } from "@/api/client";
import { accountsForMethod, cleanLast4Input, normalizeReference } from "@/collections/checkout";
import {
  collectionKeys,
  invalidateCollections,
  useCollectionAccess,
  useCollectionAccounts,
} from "@/collections/queries";
import { canDecide, canReopen, reopenDeadline } from "@/collections/rules";
import { AccountPicker } from "@/components/collections/AccountPicker";
import { CollectionBadge } from "@/components/collections/CollectionBadge";
import { collectionErrorText, useCollectionDecisions, type DecisionKind } from "@/components/collections/useCollectionDecisions";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { customerRoute } from "@/lib/customer-phone";
import { money, shortDate } from "@/lib/format";
import { useGoBack } from "@/lib/nav";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Detail = collections.CollectionDetailDTO;

const LAST4_RE = /^\d{4}$/;
const REFERENCE_RE = /^[0-9A-Za-z]{4,16}$/;

function ltr(s: string): string {
  return `⁦${s}⁩`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shortDate(iso)} · ${ltr(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}`;
}

/**
 * One transfer (doc 15 spec 08 §4.8): head, account, sale, payer (editable
 * while pending), decision, flags — and the three decisions under their
 * rules: confirm / reject for the owner and `confirm_collections` (never on a
 * sale you recorded, the four-eyes rule — the buttons render disabled and
 * nothing is sent), reopen for the owner within 7 days. Every decision
 * carries an Idempotency-Key minted when its sheet opens.
 */
export default function CollectionDetailScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const goBack = useGoBack("/collections");
  const { id } = useLocalSearchParams<{ id: string }>();
  const collectionId = typeof id === "string" ? id : "";
  const access = useCollectionAccess();

  const q = useQuery({
    queryKey: collectionKeys.detail(collectionId),
    enabled: collectionId.length > 0,
    queryFn: () => collections.getCollection(api, collectionId),
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 403)) && count < 2,
  });
  const c = q.data ?? null;

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(h);
  }, [notice]);

  const decisions = useCollectionDecisions((kind: DecisionKind) => {
    setNotice(
      t(
        kind === "confirm"
          ? "app.collections.detail.done.confirmed"
          : kind === "reject"
            ? "app.collections.detail.done.rejected"
            : "app.collections.detail.done.reopened",
      ),
    );
  });

  const [editOpen, setEditOpen] = useState(false);
  // Remount key, bumped when the sheet opens: its form starts from the row.
  const [editMount, setEditMount] = useState(0);

  if (q.isLoading) {
    return (
      <Screen>
        <Crumb onPress={goBack} />
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }
  if (!c) {
    const missing = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <Crumb onPress={goBack} />
        <Card>
          <EmptyState
            title={missing ? collectionErrorText(q.error) : t("app.collections.inbox.loadFailed")}
            compact
          />
          {!missing ? <Button label={t("app.common.retry")} variant="outline" onPress={() => void q.refetch()} /> : null}
        </Card>
      </Screen>
    );
  }

  const decide = canDecide(access, c);
  const showDecide = decide === "ok" || decide === "self";
  const reopenable = canReopen(access, c);
  const deadline = reopenDeadline(c);
  const recordedByMe = c.recordedBy?.id != null && c.recordedBy.id === access.userId;
  const canEdit = c.status === "pending" && (access.canConfirm || (recordedByMe && access.canRecord));
  const decisionEvent = [...(c.events ?? [])]
    .reverse()
    .find((e) => e.kind === "confirmed" || e.kind === "rejected" || e.kind === "auto_confirmed");
  const decisionNote = typeof decisionEvent?.details?.note === "string" ? (decisionEvent.details.note as string) : null;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Crumb onPress={goBack} />

      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} testID="collection-notice">
            {notice}
          </Text>
        </View>
      ) : null}

      {/* Head */}
      <View style={styles.head} testID="collection-detail-head">
        <Text style={styles.kicker}>{t("app.collections.detail.title")}</Text>
        <Text style={styles.amount}>{money(c.amount)}</Text>
        <View style={styles.badges}>
          <CollectionBadge status={c.status} />
          <Badge label={t(`app.activityLabels.paymentMethods.${c.method}`)} variant="accent" />
          {c.isStale && c.status === "pending" ? (
            <Badge label={t("app.collections.inbox.staleBadge")} variant="outofstock" />
          ) : null}
        </View>
      </View>

      {/* Decisions */}
      {showDecide ? (
        <Card>
          <View style={styles.actions}>
            <View testID="collection-confirm" collapsable={false} style={styles.action}>
              <Button
                label={t("app.collections.detail.confirm")}
                onPress={() => decisions.open("confirm", c)}
                disabled={decide === "self" || !decisions.online}
              />
            </View>
            <View testID="collection-reject" collapsable={false} style={styles.action}>
              <Button
                label={t("app.collections.detail.reject")}
                variant="outline"
                onPress={() => decisions.open("reject", c)}
                disabled={decide === "self" || !decisions.online}
              />
            </View>
          </View>
          {decide === "self" ? (
            <Text style={styles.warn} testID="collection-self-blocked">
              {t("app.collections.detail.selfDecisionBlocked")}
            </Text>
          ) : null}
          {!decisions.online ? <Text style={styles.hint}>{t("app.collections.detail.onlineOnly")}</Text> : null}
        </Card>
      ) : null}

      {/* Account */}
      <Card title={t("app.collections.detail.account")}>
        {c.account ? (
          <>
            <Row label={t("app.collections.detail.account")} value={c.account.label} />
            <Row label={t("app.collections.detail.method")} value={t(`app.collections.vocab.providers.${c.account.provider}`)} />
            <Row label="" value={ltr(c.account.mask)} />
          </>
        ) : (
          <Text style={styles.hint}>{t("app.collections.inbox.row.noAccount")}</Text>
        )}
      </Card>

      {/* Sale */}
      <Card title={c.sourceType === "settlement" ? t("app.collections.detail.settlement") : t("app.collections.detail.invoice")}>
        {c.invoiceId ? <Row label={t("app.collections.detail.invoice")} value={ltr(c.invoiceId)} /> : null}
        {c.partsCount > 1 ? (
          <Row label="" value={t("app.collections.inbox.row.part", { n: c.partNo, total: c.partsCount })} />
        ) : null}
        <Row label={t("app.collections.detail.rungAt")} value={when(c.rungAt)} />
        {c.recordedBy ? <Row label={t("app.collections.detail.recordedBy")} value={c.recordedBy.name ?? "—"} /> : null}
        {c.sourceType === "sale" && c.anchorSaleId ? (
          <LinkRow
            label={t("app.collections.detail.openInvoice")}
            onPress={() => router.push(`/sales/${encodeURIComponent(c.anchorSaleId!)}`)}
            testID="collection-open-invoice"
          />
        ) : null}
        {c.customerPhone ? (
          <LinkRow
            label={`${t("app.collections.detail.customer")} ${ltr(c.customerPhone)}`}
            onPress={() => router.push(customerRoute(c.customerPhone!) as never)}
            testID="collection-open-customer"
          />
        ) : null}
      </Card>

      {/* Payer */}
      <Card title={t("app.collections.detail.payer")}>
        <Row label={t("app.collections.detail.payerLast4")} value={c.payerPhoneLast4 ? ltr(c.payerPhoneLast4) : "—"} />
        <Row label={t("app.collections.detail.reference")} value={c.payerReference ? ltr(c.payerReference) : "—"} />
        {canEdit ? (
          <View testID="collection-edit" collapsable={false} style={styles.editBtn}>
            <Button
              label={t("app.collections.detail.edit")}
              variant="outline"
              onPress={() => {
                setEditMount((n) => n + 1);
                setEditOpen(true);
              }}
              disabled={!decisions.online}
            />
          </View>
        ) : null}
      </Card>

      {/* Decision */}
      {c.decidedAt || c.status !== "pending" ? (
        <Card title={t("app.collections.detail.decision")}>
          <Row
            label={t("app.collections.detail.decidedBy")}
            value={c.decidedBy?.name ?? (c.status === "auto_confirmed" ? t("app.collections.vocab.status.auto_confirmed") : "—")}
          />
          <Row label={t("app.collections.detail.decidedAt")} value={when(c.decidedAt)} />
          {c.rejectReason ? (
            <Row label={t("app.collections.detail.reason")} value={t(`app.collections.vocab.reasons.${c.rejectReason}`)} />
          ) : null}
          {c.rejectOutcome ? (
            <Row label={t("app.collections.detail.outcome")} value={t(`app.collections.vocab.outcomes.${c.rejectOutcome}`)} />
          ) : null}
          {decisionNote ? <Row label={t("app.collections.detail.note")} value={decisionNote} /> : null}
          {reopenable ? (
            <>
              {deadline ? (
                <Text style={styles.hint}>{t("app.collections.detail.reopenUntil", { date: shortDate(deadline.toISOString()) })}</Text>
              ) : null}
              <View testID="collection-reopen" collapsable={false}>
                <Button
                  label={t("app.collections.detail.reopen")}
                  variant="outline"
                  onPress={() => decisions.open("reopen", c)}
                  disabled={!decisions.online}
                />
              </View>
            </>
          ) : null}
        </Card>
      ) : null}

      {/* Flags */}
      {c.flags.length > 0 ? (
        <Card title={t("app.collections.detail.flags")}>
          <View style={styles.badges}>
            {c.flags.map((f) => (
              <Badge key={f} label={t(`app.collections.vocab.flags.${f}`)} variant="neutral" />
            ))}
          </View>
        </Card>
      ) : null}

      {/* Matched credit (M2, §4.8): the bank / wallet message that confirmed it */}
      {c.matchedCredit ? (
        <Card title={t("app.collections.detail.matchedCredit")}>
          <Row label={t("app.collections.detail.amount")} value={money(c.matchedCredit.amount)} />
          <Row label={t("app.collections.credits.occurredAt")} value={when(c.matchedCredit.occurredAt)} />
          {c.matchedCredit.payerNameMasked ? (
            <Row label={t("app.collections.detail.payer")} value={c.matchedCredit.payerNameMasked} />
          ) : null}
          {c.matchedCredit.operatorReference ? (
            <Row label={t("app.collections.detail.reference")} value={ltr(c.matchedCredit.operatorReference)} />
          ) : null}
          <Row
            label={t("app.collections.credits.channels")}
            value={c.matchedCredit.channels.map((ch) => t(`app.collections.vocab.channels.${ch}`)).join(" · ") || "—"}
          />
          <LinkRow
            label={t("app.collections.credits.title")}
            onPress={() => router.push(`/collections/credit/${encodeURIComponent(c.matchedCredit!.id)}`)}
            testID="collection-open-credit"
          />
        </Card>
      ) : null}

      {decisions.sheets}
      <EditSheet
        key={`edit-${editMount}`}
        collection={editOpen ? c : null}
        onClose={() => setEditOpen(false)}
        onSaved={async () => {
          setEditOpen(false);
          setNotice(t("app.collections.detail.done.saved"));
          await invalidateCollections(qc);
        }}
      />
    </Screen>
  );
}

function Crumb({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("app.common.back")}
      hitSlop={8}
      style={styles.crumb}
      onPress={onPress}
      testID="back-link"
    >
      <ChevronBack size={16} color={colors.textSecondary} />
      <Text style={styles.crumbText}>{t("app.collections.inbox.title")}</Text>
    </Pressable>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      {label ? <Text style={styles.rowLabel}>{label}</Text> : <View />}
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function LinkRow({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
      testID={testID}
    >
      <Text style={styles.linkText} numberOfLines={1}>
        {label}
      </Text>
      <ChevronForward size={16} color={colors.accent} />
    </Pressable>
  );
}

/**
 * Add or fix the payer hints and the account while pending (PATCH
 * collections/[id]; the recorder with record_sales, or a confirmer). Not a
 * decision: no Idempotency-Key on the route; a replayed PATCH is harmless.
 */
function EditSheet({
  collection,
  onClose,
  onSaved,
}: {
  collection: Detail | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const accountsQ = useCollectionAccounts(Boolean(collection));
  const listed = collection ? accountsForMethod(collection.method, accountsQ.accounts, accountsQ.branchId) : [];
  // Initialised from the collection; the screen remounts this sheet (key) each time it opens.
  const [accountId, setAccountId] = useState<string | null>(() => collection?.account?.id ?? null);
  const [last4, setLast4] = useState(() => collection?.payerPhoneLast4 ?? "");
  const [ref, setRef] = useState(() => collection?.payerReference ?? "");

  const save = useMutation({
    mutationFn: () => {
      const c = collection!;
      const refNorm = normalizeReference(ref);
      const body: collections.UpdateCollectionBody = {};
      if (accountId && accountId !== (c.account?.id ?? null)) body.collectionAccountId = accountId;
      if (last4 !== (c.payerPhoneLast4 ?? "")) body.payerPhoneLast4 = last4 || null;
      if (refNorm !== (c.payerReference ?? "")) body.payerReference = refNorm || null;
      return collections.updateCollection(api, c.id, body);
    },
    onSuccess: () => onSaved(),
  });
  const last4Bad = last4 !== "" && !LAST4_RE.test(last4);
  const refBad = normalizeReference(ref) !== "" && !REFERENCE_RE.test(normalizeReference(ref));

  return (
    <Sheet
      visible={Boolean(collection)}
      onClose={() => {
        if (save.isPending) return;
        save.reset();
        onClose();
      }}
      title={t("app.collections.detail.editSheet.title")}
      testID="collection-edit-sheet"
      primaryAction={{
        label: t("app.collections.detail.save"),
        onPress: () => save.mutate(),
        loading: save.isPending,
        disabled: save.isPending || last4Bad || refBad,
        testID: "collection-edit-save",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: save.isPending }}
    >
      {listed.length > 0 ? (
        <View style={styles.gap}>
          <Text style={styles.label}>{t("app.collections.pos.pickAccount")}</Text>
          <AccountPicker accounts={listed} value={accountId} onChange={setAccountId} testIDPrefix="collection-edit-account-" />
        </View>
      ) : null}
      <Field
        label={t("app.collections.pos.payerLast4Label")}
        value={last4}
        onChangeText={(v) => setLast4(cleanLast4Input(v))}
        keyboardType="number-pad"
        maxLength={4}
        ltr
        testID="collection-edit-payer"
      />
      {last4Bad ? <Text style={styles.error}>{t("app.collections.pos.payerLast4Invalid")}</Text> : null}
      <Field
        label={t("app.collections.pos.referenceLabel")}
        value={ref}
        onChangeText={setRef}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={16}
        ltr
        testID="collection-edit-ref"
      />
      {refBad ? <Text style={styles.error}>{t("app.collections.pos.referenceInvalid")}</Text> : null}
      {save.isError ? <Text style={styles.error}>{collectionErrorText(save.error)}</Text> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  crumb: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.xs, minHeight: MIN_TOUCH },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  notice: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, backgroundColor: colors.successLight, borderColor: colors.successStrong },
  noticeText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.successStrong },
  head: { gap: spacing.xs, alignItems: "flex-start" },
  kicker: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  amount: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 28, color: colors.text, fontVariant: ["tabular-nums"] },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  actions: { flexDirection: "row", gap: spacing.sm },
  action: { flex: 1 },
  warn: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.warningStrong, marginTop: spacing.sm },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md, minHeight: 30 },
  rowLabel: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  rowValue: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text, textAlign: "right" },
  link: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, minHeight: MIN_TOUCH, borderRadius: radius.md },
  linkPressed: { backgroundColor: colors.accentLight },
  linkText: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
  editBtn: { marginTop: spacing.sm },
  gap: { gap: spacing.sm },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
});
