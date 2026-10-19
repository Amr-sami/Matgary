import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { collectionCredits } from "@matgary/api-client";

import { api } from "@/api/client";
import { collectionKeys } from "@/collections/queries";
import { ltr, timeOf } from "@/components/collections/CreditRow";
import { collectionErrorText } from "@/components/collections/useCollectionDecisions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { t } from "@/i18n";
import { shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

type Unrecognised = collectionCredits.UnrecognisedDTO;

const PAGE_SIZE = 20;

/**
 * "Unrecognised messages" — OWNER ONLY, at the bottom of the credits tab
 * (doc 15 spec 08 ARCH CHANGE REQUEST 8, the M2 home of 07's
 * `GET collections/unrecognised` + `POST …/[id]/share` on the phone; the web's
 * twin is 12's `UnrecognisedList`). Messages the parser could not read,
 * decrypted server-side (each page read is one `collection.raw_view` in the
 * activity log), kept 30 days. `unrecognised-share-<id>` sends one to
 * TheStoro (idempotent; the copy TheStoro keeps is redacted, 03 §D.6).
 *
 * The caller renders it only for the owner (the server answers 403 to anyone
 * else) and only online. Raw text is never cached to disk: the
 * `collection-credits` root is not in SNAPSHOT_ROOTS.
 */
export function UnrecognisedSection({ online }: { online: boolean }) {
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: collectionKeys.unrecognised(),
    enabled: online,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => collectionCredits.listUnrecognised(api, { cursor: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (last, _pages, lastParam) =>
      last.nextCursor && last.nextCursor !== lastParam ? last.nextCursor : null,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const [error, setError] = useState<string | null>(null);
  const share = useMutation({
    mutationFn: (id: string) => collectionCredits.shareUnrecognised(api, id),
    onMutate: () => setError(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: collectionKeys.unrecognised() }),
    onError: (e) => setError(collectionErrorText(e)),
  });

  return (
    <Card title={t("app.collections.credits.unrecognised.title")}>
      <View testID="collections-unrecognised" collapsable={false} style={styles.body}>
        <Text style={styles.hint}>{t("app.collections.credits.unrecognised.hint")}</Text>
        <Text style={styles.note}>{t("app.collections.credits.unrecognised.shareNote")}</Text>
        {error ? (
          <Text style={styles.error} testID="unrecognised-error">
            {error}
          </Text>
        ) : null}
        {q.isLoading ? (
          <ActivityIndicator color={colors.accent} />
        ) : q.isError ? (
          <View style={styles.body}>
            <Text style={styles.hint}>{collectionErrorText(q.error)}</Text>
            <Button label={t("app.common.retry")} variant="outline" onPress={() => void q.refetch()} />
          </View>
        ) : rows.length === 0 ? (
          <Text style={styles.empty} testID="collections-unrecognised-empty">
            {t("app.collections.credits.unrecognised.empty")}
          </Text>
        ) : (
          rows.map((m) => (
            <UnrecognisedRow
              key={m.id}
              m={m}
              online={online}
              busy={share.isPending && share.variables === m.id}
              disabled={share.isPending}
              onShare={() => share.mutate(m.id)}
            />
          ))
        )}
        {q.hasNextPage ? (
          <View testID="unrecognised-load-more" collapsable={false}>
            <Button
              label={t("app.common.showMore")}
              variant="outline"
              loading={q.isFetchingNextPage}
              onPress={() => void q.fetchNextPage()}
            />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function UnrecognisedRow({
  m,
  online,
  busy,
  disabled,
  onShare,
}: {
  m: Unrecognised;
  online: boolean;
  busy: boolean;
  disabled: boolean;
  onShare: () => void;
}) {
  const head = [m.sender ? ltr(m.sender) : null, t(`app.collections.vocab.channels.${m.channel}`), `${shortDate(m.receivedAt)} ${ltr(timeOf(m.receivedAt))}`]
    .filter(Boolean)
    .join(" · ");
  const titleLine = [m.title, m.subtitle].filter(Boolean).join(" · ");
  return (
    <View style={styles.row} testID={`unrecognised-row-${m.id}`} collapsable={false}>
      <Text style={styles.meta} numberOfLines={1}>
        {head}
      </Text>
      {titleLine ? <Text style={styles.msgTitle}>{titleLine}</Text> : null}
      <View style={styles.msgBox}>
        <Text style={styles.msg} selectable>
          {m.body}
        </Text>
      </View>
      {m.sharedAt ? (
        <Text style={styles.shared} testID={`unrecognised-shared-${m.id}`}>
          {t("app.collections.credits.unrecognised.shared", { date: shortDate(m.expiresAt) })}
        </Text>
      ) : (
        <View style={styles.shareRow}>
          <View testID={`unrecognised-share-${m.id}`} collapsable={false}>
            <Button
              label={t("app.collections.credits.unrecognised.share")}
              variant="outline"
              onPress={onShare}
              loading={busy}
              disabled={!online || disabled}
            />
          </View>
          <Text style={styles.meta}>{t("app.collections.credits.unrecognised.expires", { date: shortDate(m.expiresAt) })}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  note: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  empty: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, paddingVertical: spacing.md },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
  row: {
    gap: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  meta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  msgTitle: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 13, color: colors.text },
  msgBox: { borderRadius: radius.md, backgroundColor: colors.neutralTint, padding: spacing.sm },
  // The message's own language decides its direction (Arabic SMS, English bank app).
  msg: { fontFamily: fonts.regular, fontSize: 13, color: colors.text, lineHeight: 20, writingDirection: "auto" },
  shared: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12, color: colors.successStrong },
  shareRow: { gap: spacing.xs },
});
