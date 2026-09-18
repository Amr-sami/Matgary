import { useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useRouter } from "expo-router";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { ChecksIcon as Checks } from "phosphor-react-native/src/icons/Checks";
import { InfoIcon as Info } from "phosphor-react-native/src/icons/Info";
import { notifications, type MeResponse } from "@matgary/api-client";

import { api } from "@/api/client";
import {
  KIND_ICON,
  KIND_TONE,
  NOTIFICATION_KEYS,
  NOTIFICATION_LIST_QUERY,
  routeForNotification,
} from "@/components/shell/NotificationBell";
import { OfflineChip } from "@/components/shell/OfflineChip";
import { Button } from "@/components/ui/Button";
import { ChevronBack } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { t, useLocale } from "@/i18n";
import { shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

type Item = notifications.NotificationItem;
type Me = MeResponse;

/**
 * The notification centre — the screen the web's dropdown never became
 * (doc 02 §1.4, §2.12). First real consumer of the fanout rows.
 *
 * A FlashList over useInfiniteQuery: the web route returns the newest 30 rows
 * with no cursor today, and `nextCursor` (when the server grows it) drives
 * onEndReached. Tap = mark read + route by link/kind; unread rows are tinted
 * and dotted; the tray badge clears on open (doc 06 §8.5 "clear on inbox open").
 */

/** Web formatRelative, via t() so the English path exists (Hermes: no Intl). */
function relativeUnit(unit: "minutes" | "hours" | "days", n: number): string {
  const form = n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
  return t(`app.activity.relative.${unit}${form}`, { n });
}

function relative(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  // Shared with Activity: same wording and the Arabic 1 / 2 / 3–10 forms.
  if (sec < 60) return t("app.activity.relative.now");
  if (sec < 3600) return relativeUnit("minutes", Math.floor(sec / 60));
  if (sec < 86400) return relativeUnit("hours", Math.floor(sec / 3600));
  if (sec < 86400 * 7) return relativeUnit("days", Math.floor(sec / 86400));
  return shortDate(iso);
}

export default function NotificationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useSession((s) => s.me);
  useLocale(); // re-render on language switch: every string below is t()

  // Same key + fn as the bell: opening the inbox reuses the badge's page.
  const q = useInfiniteQuery(NOTIFICATION_LIST_QUERY);

  const rows = useMemo<Item[]>(() => {
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const page of q.data?.pages ?? []) {
      for (const n of page.data) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n);
      }
    }
    return out;
  }, [q.data]);

  const unread = q.data?.pages[0]?.unread ?? rows.filter((n) => !n.isRead).length;

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: NOTIFICATION_KEYS.root }),
    [queryClient],
  );

  /** Flip rows in the list cache without waiting for the server. */
  const patchCache = useCallback(
    (pred: (n: Item) => boolean) => {
      queryClient.setQueryData<typeof q.data>(NOTIFICATION_KEYS.list, (old) => {
        if (!old) return old;
        let flipped = 0;
        const pages = old.pages.map((p) => ({
          ...p,
          data: p.data.map((n) => {
            if (n.isRead || !pred(n)) return n;
            flipped += 1;
            return { ...n, isRead: true };
          }),
        }));
        // pages[0].unread is what the bell shows, so the badge moves with the row.
        if (pages[0]) pages[0] = { ...pages[0], unread: Math.max(0, pages[0].unread - flipped) };
        return { ...old, pages };
      });
    },
    [queryClient, q.data],
  );

  const markRead = useMutation({
    mutationFn: (id: string) => notifications.markRead(api, id),
    onMutate: (id) => patchCache((n) => n.id === id),
    onSettled: () => void invalidate(),
  });

  const markAll = useMutation({
    mutationFn: () => notifications.markAllRead(api),
    onMutate: () => {
      patchCache(() => true);
      queryClient.setQueryData<typeof q.data>(NOTIFICATION_KEYS.list, (old) =>
        old && old.pages[0] ? { ...old, pages: [{ ...old.pages[0], unread: 0 }, ...old.pages.slice(1)] } : old,
      );
    },
    onSettled: () => void invalidate(),
  });

  // Opening the inbox clears the tray badge (doc 06 §8.5). Never throws into
  // the tree — the simulator and a denied permission both reject here.
  useEffect(() => {
    Notifications.setBadgeCountAsync(0).catch(() => {});
  }, []);

  const onPressRow = useCallback(
    (n: Item) => {
      if (!n.isRead) markRead.mutate(n.id);
      const route = routeForNotification(n, me);
      if (route) router.push(route as never);
    },
    [markRead, router, me],
  );

  // A hidden tab route: the bar highlights nothing, so the screen carries its
  // own way out. A cold-start push tap lands here with no history — go home.
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  const header = (
    <View style={styles.header}>
      <View style={styles.accessoryRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("app.common.back")}
          onPress={goBack}
          hitSlop={12}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
        >
          <ChevronBack size={18} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.common.back")}</Text>
        </Pressable>
        <View style={styles.spacer} />
        <OfflineChip />
      </View>
      <View style={styles.titleRow}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{t("app.shell.notifications.title")}</Text>
          <Text style={styles.subtitle}>
            {unread > 0
              ? t("app.shell.notifications.unreadCount", { count: unread })
              : t("mobile.notifications.subtitle")}
          </Text>
        </View>
        {unread > 0 ? (
          <Pressable
            testID="notifications-mark-all"
            accessibilityRole="button"
            onPress={() => markAll.mutate()}
            disabled={markAll.isPending}
            hitSlop={8}
            style={({ pressed }) => [styles.markAll, pressed && styles.markAllPressed]}
          >
            <Checks size={16} color={colors.accent} />
            <Text style={styles.markAllLabel} numberOfLines={1}>
              {t("app.shell.notifications.markAllRead")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {markAll.isError || markRead.isError ? (
        <Text style={styles.notice}>{t("mobile.notifications.updateFailed")}</Text>
      ) : null}
    </View>
  );

  const empty = q.isLoading ? (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.centerText}>{t("app.shell.notifications.loading")}</Text>
    </View>
  ) : q.isError ? (
    <View style={styles.center}>
      <Text style={styles.centerText}>{t("mobile.notifications.loadError")}</Text>
      <Button
        label={t("mobile.notifications.retry")}
        variant="outline"
        onPress={() => void q.refetch()}
      />
    </View>
  ) : (
    <View style={styles.listCard}>
      <EmptyState
        title={t("app.shell.notifications.empty")}
        hint={t("mobile.notifications.emptyHint")}
      />
    </View>
  );

  const footer = q.isFetchingNextPage ? (
    <ActivityIndicator color={colors.accent} style={styles.footer} />
  ) : null;

  return (
    <View style={styles.root}>
      <FlashList
        data={rows}
        keyExtractor={(n) => n.id}
        renderItem={({ item, index }) => (
          <Row
            n={item}
            me={me}
            first={index === 0}
            last={index === rows.length - 1}
            onPress={onPressRow}
          />
        )}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={empty}
        onEndReached={() => {
          if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={q.isRefetching && !q.isFetchingNextPage}
            onRefresh={() => void invalidate()}
          />
        }
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

function Row({
  n,
  me,
  first,
  last,
  onPress,
}: {
  n: Item;
  me: Me | null;
  first: boolean;
  last: boolean;
  onPress: (n: Item) => void;
}) {
  const Icon = KIND_ICON[n.kind] ?? Info;
  const tone = KIND_TONE[n.kind] ?? KIND_TONE.info;
  const navigable = routeForNotification(n, me) !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={n.title}
      accessibilityHint={n.isRead ? undefined : t("mobile.notifications.unread")}
      onPress={() => onPress(n)}
      style={({ pressed }) => [
        styles.row,
        first && styles.rowFirst,
        last && styles.rowLast,
        !n.isRead && styles.rowUnread,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: tone.bg }]}>
        <Icon size={18} color={tone.fg} weight={n.isRead ? "regular" : "fill"} />
      </View>
      <View style={styles.rowBody}>
        <Text
          style={[styles.rowTitle, !n.isRead && styles.rowTitleUnread]}
          numberOfLines={2}
        >
          {n.title}
        </Text>
        {n.body ? (
          <Text style={styles.rowText} numberOfLines={2}>
            {n.body}
          </Text>
        ) : null}
        <Text style={styles.rowTime}>{relative(n.createdAt)}</Text>
      </View>
      {!n.isRead ? (
        <View style={styles.dot} accessibilityElementsHidden />
      ) : navigable ? (
        <View style={styles.dotSpacer} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl * 2 },
  header: { gap: spacing.md, marginBottom: spacing.lg },
  accessoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    alignSelf: "stretch",
  },
  spacer: { flex: 1 },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: MIN_TOUCH,
    paddingEnd: spacing.sm,
    borderRadius: radius.md,
    // Pull the glyph flush with the title's edge; the tap target keeps its width.
    marginStart: -4,
    paddingStart: 4,
  },
  backPressed: { backgroundColor: colors.neutralTint },
  backLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  titleBlock: { flex: 1, gap: 4, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  markAll: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginTop: 4,
  },
  markAllPressed: { backgroundColor: colors.accentLight },
  markAllLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.accent },
  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.danger,
    backgroundColor: colors.dangerLight,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  center: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxl * 2 },
  centerText: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  listCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xl,
    ...elevation.card,
  },
  footer: { marginVertical: spacing.lg },

  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderTopWidth: 0,
    minHeight: MIN_TOUCH + spacing.lg,
  },
  rowFirst: {
    borderTopWidth: 1,
    borderTopStartRadius: radius.lg,
    borderTopEndRadius: radius.lg,
  },
  rowLast: {
    borderBottomStartRadius: radius.lg,
    borderBottomEndRadius: radius.lg,
  },
  rowUnread: { backgroundColor: colors.accentLight },
  rowPressed: { backgroundColor: colors.neutralTint },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  rowBody: { flex: 1, gap: 2, alignItems: "flex-start" },
  rowTitle: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowTitleUnread: { ...RTL_TEXT, fontFamily: fonts.semibold },
  rowText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  rowTime: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    marginTop: 8,
  },
  dotSpacer: { width: 8 },
});
