import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ApiError, collectionCredits } from "@matgary/api-client";

import { api } from "@/api/client";
import {
  collectionKeys,
  invalidateCollections,
  newIdempotencyKey,
  useCollectionAccess,
  useCollectionsFeatures,
} from "@/collections/queries";
import {
  IGNORE_REASONS,
  canMatchCandidate,
  candidateWarnings,
  creditPayerText,
  creditsAccess,
} from "@/collections/rules";
import { ltr, timeOf } from "@/components/collections/CreditRow";
import { CollectionBadge } from "@/components/collections/CollectionBadge";
import { collectionErrorText } from "@/components/collections/useCollectionDecisions";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { money, shortDate } from "@/lib/format";
import { useGoBack } from "@/lib/nav";
import { useOffline } from "@/stores/offline";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type CreditDetail = collectionCredits.CreditDetailDTO;
type Candidate = collectionCredits.CollectionCandidate;
type IgnoreReason = collectionCredits.IgnoreReason;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${shortDate(iso)} · ${ltr(timeOf(iso))}`;
}

/** Errors after which the screen's picture is stale: show the sentence AND refetch. */
const REFETCH_ON = new Set(["CREDIT_ALREADY_MATCHED", "COLLECTION_NOT_PENDING", "CREDIT_NOT_MATCHABLE"]);

/**
 * One bank / wallet message (doc 15 spec 08 §4.11, M2): what it says, and
 * every candidate pending collection the server ranked for it
 * (`candidates`, ≤ 10). `credit-match-<collectionId>` matches it in ONE tap
 * (`POST collections/credits/[id]/match`) — the collection becomes
 * `confirmed` — with a warning line when the amount or the account differs
 * (§C.8 rule 11). `credit-ignore` opens the reason chips
 * (`credit-ignore-reason-<reason>`). Both follow the four-eyes rule on the
 * collection (staff never match a sale they recorded; the button renders
 * disabled and nothing is sent) and carry an Idempotency-Key minted on open
 * (one per candidate for a match, so a failed try on one never collides
 * with a try on another). Online only (03 §C.5).
 */
export default function CreditScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const goBack = useGoBack("/collections?tab=credits");
  const { id } = useLocalSearchParams<{ id: string }>();
  const creditId = typeof id === "string" ? id : "";
  const access = useCollectionAccess();
  const features = useCollectionsFeatures();
  const rights = creditsAccess(features, access);
  const online = useOffline((s) => s.online);

  const q = useQuery({
    queryKey: collectionKeys.credit(creditId),
    enabled: creditId.length > 0 && rights.canList,
    queryFn: () => collectionCredits.getCredit(api, creditId),
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 403)) && count < 2,
  });
  const credit = q.data ?? null;

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(h);
  }, [notice]);

  // One Idempotency-Key per candidate for this opening of the screen: a
  // retry on the same candidate replays, it never matches twice.
  const matchKeys = useRef(new Map<string, string>());
  const keyFor = (collectionId: string) => {
    let k = matchKeys.current.get(collectionId);
    if (!k) {
      k = newIdempotencyKey();
      matchKeys.current.set(collectionId, k);
    }
    return k;
  };

  const match = useMutation({
    mutationFn: (collectionId: string) => collectionCredits.matchCredit(api, creditId, collectionId, keyFor(collectionId)),
    onSuccess: async (res) => {
      // Show the matched state at once (the candidates go), then refetch everything the match moved.
      qc.setQueryData<CreditDetail>(collectionKeys.credit(creditId), (old) =>
        old ? { ...old, ...res.credit, candidates: [] } : old,
      );
      setNotice(t("app.collections.credits.done.matched"));
      await invalidateCollections(qc);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code && REFETCH_ON.has(e.code)) void invalidateCollections(qc);
    },
  });

  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreMount, setIgnoreMount] = useState(0);

  if (!rights.canList) {
    return (
      <Screen>
        <Crumb onPress={goBack} />
        <Card>
          <View testID="collections-denied" collapsable={false}>
            <EmptyState title={t("app.collections.inbox.denied.title")} hint={t("app.collections.inbox.denied.hint")} />
          </View>
        </Card>
      </Screen>
    );
  }
  if (q.isLoading) {
    return (
      <Screen>
        <Crumb onPress={goBack} />
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }
  if (!credit) {
    const missing = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <Crumb onPress={goBack} />
        <Card>
          <EmptyState
            title={
              !online
                ? t("app.collections.inbox.offline.title")
                : missing
                  ? collectionErrorText(q.error)
                  : t("app.collections.inbox.loadFailed")
            }
            compact
          />
          {!missing ? <Button label={t("app.common.retry")} variant="outline" onPress={() => void q.refetch()} /> : null}
        </Card>
      </Screen>
    );
  }

  const open = credit.state === "unmatched" || credit.state === "held";
  const payer = creditPayerText(credit);
  const matched = credit.matchedCollection;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Crumb onPress={goBack} />

      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} testID="credit-notice">
            {notice}
          </Text>
        </View>
      ) : null}

      {/* Head */}
      <View style={styles.head} testID="credit-detail" collapsable={false}>
        <Text style={styles.kicker}>{t("app.collections.credits.title")}</Text>
        <Text style={styles.amount}>{money(credit.amount)}</Text>
        <View style={styles.badges}>
          <View testID={`credit-state-${credit.state}`} collapsable={false}>
            <Badge
              label={t(`app.collections.credits.states.${credit.state}`)}
              variant={credit.state === "matched" ? "success" : credit.state === "held" ? "lowstock" : "neutral"}
            />
          </View>
          {credit.state === "held" && credit.holdReason ? (
            <View testID={`credit-hold-${credit.holdReason}`} collapsable={false}>
              <Badge label={t(`app.collections.vocab.holdReasons.${credit.holdReason}`)} variant="lowstock" />
            </View>
          ) : null}
        </View>
      </View>

      {/* What the message says */}
      <Card>
        <Row
          label={t("app.collections.detail.account")}
          value={
            credit.account
              ? `${credit.account.label} · ${t(`app.collections.vocab.providers.${credit.account.provider}`)}`
              : t("app.collections.inbox.row.noAccount")
          }
        />
        {credit.account?.mask ? <Row label="" value={ltr(credit.account.mask)} /> : null}
        <Row label={t("app.collections.credits.occurredAt")} value={when(credit.occurredAt)} />
        {payer ? <Row label={t("app.collections.detail.payer")} value={payer} /> : null}
        {credit.operatorReference ? (
          <Row label={t("app.collections.detail.reference")} value={ltr(credit.operatorReference)} />
        ) : null}
        {credit.sender ? <Row label={t("app.collections.credits.sender")} value={ltr(credit.sender)} /> : null}
        <Row
          label={t("app.collections.credits.channels")}
          value={credit.channels.map((ch) => t(`app.collections.vocab.channels.${ch}`)).join(" · ") || "—"}
        />
      </Card>

      {/* Matched: which sale it confirmed */}
      {credit.state === "matched" && matched ? (
        <Card title={t("app.collections.credits.states.matched")}>
          <View style={styles.badges}>
            <CollectionBadge status={matched.status} />
          </View>
          <Row
            label=""
            value={
              matched.invoiceId
                ? t("app.collections.credits.matchedTo", { invoice: ltr(matched.invoiceId) })
                : money(matched.amount)
            }
          />
          {credit.decidedBy?.name ? <Row label={t("app.collections.detail.decidedBy")} value={credit.decidedBy.name} /> : null}
          <LinkRow
            label={t("app.collections.detail.openInCollections")}
            onPress={() => router.push(`/collections/${encodeURIComponent(matched.id)}`)}
            testID="credit-open-collection"
          />
        </Card>
      ) : null}

      {/* Ignored: why */}
      {credit.state === "ignored" ? (
        <Card title={t("app.collections.credits.states.ignored")}>
          {credit.ignoredReason ? (
            <Row label={t("app.collections.detail.reason")} value={t(`app.collections.vocab.ignoreReasons.${credit.ignoredReason}`)} />
          ) : null}
          {credit.decidedBy?.name ? <Row label={t("app.collections.detail.decidedBy")} value={credit.decidedBy.name} /> : null}
          <Row label={t("app.collections.detail.decidedAt")} value={when(credit.decidedAt)} />
        </Card>
      ) : null}

      {/* Candidates: one-tap match */}
      {open ? (
        <Card title={t("app.collections.credits.candidates")}>
          {credit.candidates.length === 0 ? (
            <Text style={styles.hint} testID="credit-no-candidates">
              {t("app.collections.credits.noCandidates")}
            </Text>
          ) : (
            credit.candidates.map((cand) => (
              <CandidateRow
                key={cand.id}
                cand={cand}
                credit={credit}
                verdict={canMatchCandidate(access, credit, cand)}
                online={online}
                busy={match.isPending && match.variables === cand.id}
                disabled={match.isPending}
                onMatch={() => {
                  if (!online) return;
                  match.mutate(cand.id);
                }}
                onOpen={() => router.push(`/collections/${encodeURIComponent(cand.id)}`)}
              />
            ))
          )}
          {match.isError ? (
            <Text style={styles.error} testID="credit-action-error">
              {collectionErrorText(match.error)}
            </Text>
          ) : null}
          {!online ? <Text style={styles.hint}>{t("app.collections.detail.onlineOnly")}</Text> : null}
        </Card>
      ) : null}

      {open && rights.canIgnore ? (
        <View testID="credit-ignore" collapsable={false}>
          <Button
            label={t("app.collections.credits.ignore")}
            variant="outline"
            disabled={!online || match.isPending}
            onPress={() => {
              setIgnoreMount((n) => n + 1);
              setIgnoreOpen(true);
            }}
          />
        </View>
      ) : null}

      <IgnoreSheet
        key={`ignore-${ignoreMount}`}
        credit={ignoreOpen ? credit : null}
        online={online}
        onClose={() => setIgnoreOpen(false)}
        onDone={async (res) => {
          setIgnoreOpen(false);
          qc.setQueryData<CreditDetail>(collectionKeys.credit(creditId), (old) =>
            old ? { ...old, ...res.credit, candidates: [] } : old,
          );
          setNotice(t("app.collections.credits.done.ignored"));
          await qc.invalidateQueries({ queryKey: ["collection-credits"] });
          void qc.invalidateQueries({ queryKey: ["collection-summary"] });
        }}
      />
    </Screen>
  );
}

function CandidateRow({
  cand,
  credit,
  verdict,
  online,
  busy,
  disabled,
  onMatch,
  onOpen,
}: {
  cand: Candidate;
  credit: CreditDetail;
  verdict: ReturnType<typeof canMatchCandidate>;
  online: boolean;
  busy: boolean;
  disabled: boolean;
  onMatch: () => void;
  onOpen: () => void;
}) {
  const w = candidateWarnings(credit, cand);
  const meta = [
    cand.invoiceId ? ltr(cand.invoiceId) : t("app.collections.inbox.row.settlement"),
    when(cand.rungAt),
    cand.recordedBy?.name ? t("app.collections.inbox.row.recordedBy", { name: cand.recordedBy.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hints = [
    cand.payerPhoneLast4 ? `${t("app.collections.detail.payerLast4")} ${ltr(cand.payerPhoneLast4)}` : null,
    cand.payerReference ? `${t("app.collections.detail.reference")} ${ltr(cand.payerReference)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const showButton = verdict === "ok" || verdict === "self";
  return (
    <View style={styles.cand} testID={`credit-candidate-${cand.id}`} collapsable={false}>
      <Pressable accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [styles.candHead, pressed && styles.linkPressed]}>
        <View style={styles.candText}>
          <Text style={styles.candAmount}>
            {money(cand.amount)} · {t(`app.activityLabels.paymentMethods.${cand.method}`)}
          </Text>
          <Text style={styles.meta} numberOfLines={2}>
            {meta}
          </Text>
          {hints ? (
            <Text style={styles.meta} numberOfLines={1}>
              {hints}
            </Text>
          ) : null}
        </View>
        <ChevronForward size={16} color={colors.textSecondary} />
      </Pressable>
      {w.amountDiffers || w.accountDiffers ? (
        <View style={styles.warnBox}>
          {w.amountDiffers ? <Text style={styles.warn}>{t("app.collections.credits.amountDiffers")}</Text> : null}
          {w.accountDiffers ? <Text style={styles.warn}>{t("app.collections.credits.accountDiffers")}</Text> : null}
        </View>
      ) : null}
      {showButton ? (
        <View testID={`credit-match-${cand.id}`} collapsable={false}>
          <Button
            label={t("app.collections.credits.match")}
            onPress={onMatch}
            loading={busy}
            disabled={verdict === "self" || !online || disabled}
          />
        </View>
      ) : null}
      {verdict === "self" ? (
        <Text style={styles.warn} testID={`credit-self-blocked-${cand.id}`}>
          {t("app.collections.detail.selfDecisionBlocked")}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Ignore a credit with a reason (03 §B.1 IgnoreReason; `ignoreCredit`). The
 * Idempotency-Key is minted when the sheet mounts — the screen remounts it
 * on every opening — and reused for every retry inside it.
 */
function IgnoreSheet({
  credit,
  online,
  onClose,
  onDone,
}: {
  credit: CreditDetail | null;
  online: boolean;
  onClose: () => void;
  onDone: (res: { credit: collectionCredits.CreditDTO }) => void;
}) {
  const qc = useQueryClient();
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState<IgnoreReason | null>(null);
  const ignore = useMutation({
    mutationFn: () => collectionCredits.ignoreCredit(api, credit!.id, { reason: reason! }, key),
    onSuccess: (res) => onDone(res),
    onError: (e) => {
      if (e instanceof ApiError && e.code && REFETCH_ON.has(e.code)) void qc.invalidateQueries({ queryKey: ["collection-credits"] });
    },
  });
  return (
    <Sheet
      visible={Boolean(credit)}
      onClose={() => {
        if (ignore.isPending) return;
        onClose();
      }}
      title={t("app.collections.credits.ignoreSheet.title")}
      subtitle={credit ? money(credit.amount) : undefined}
      testID="credit-ignore-sheet"
      primaryAction={{
        label: t("app.collections.credits.ignoreSheet.submit"),
        onPress: () => {
          if (!reason || !online) return;
          ignore.mutate();
        },
        loading: ignore.isPending,
        disabled: !reason || !online || ignore.isPending,
        testID: "credit-ignore-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose, disabled: ignore.isPending }}
    >
      <View style={styles.sheetBody}>
        <Text style={styles.label}>{t("app.collections.detail.reason")}</Text>
        <View style={styles.chips}>
          {IGNORE_REASONS.map((r) => (
            <Chip
              key={r}
              label={t(`app.collections.vocab.ignoreReasons.${r}`)}
              active={reason === r}
              onPress={() => setReason(r)}
              testID={`credit-ignore-reason-${r}`}
            />
          ))}
        </View>
        {!online ? <Text style={styles.hint}>{t("app.collections.detail.onlineOnly")}</Text> : null}
        {ignore.isError ? (
          <Text style={styles.error} testID="credit-ignore-error">
            {collectionErrorText(ignore.error)}
          </Text>
        ) : null}
      </View>
    </Sheet>
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
      <Text style={styles.crumbText}>{t("app.collections.credits.title")}</Text>
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

const styles = StyleSheet.create({
  crumb: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: spacing.xs, minHeight: MIN_TOUCH },
  crumbText: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  notice: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, backgroundColor: colors.successLight, borderColor: colors.successStrong },
  noticeText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.successStrong },
  head: { gap: spacing.xs, alignItems: "flex-start" },
  kicker: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  amount: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 28, color: colors.text, fontVariant: ["tabular-nums"] },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.xs },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.danger, marginTop: spacing.sm },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md, minHeight: 30 },
  rowLabel: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  rowValue: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.text, textAlign: "right" },
  link: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, minHeight: MIN_TOUCH, borderRadius: radius.md },
  linkPressed: { backgroundColor: colors.accentLight },
  linkText: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
  cand: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  candHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: MIN_TOUCH, borderRadius: radius.md },
  candText: { flex: 1, gap: 2 },
  candAmount: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 16, color: colors.text, fontVariant: ["tabular-nums"] },
  meta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  warnBox: { borderRadius: radius.md, backgroundColor: colors.warningLight, padding: spacing.sm, gap: 2 },
  warn: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.warningStrong },
  sheetBody: { gap: spacing.md },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
