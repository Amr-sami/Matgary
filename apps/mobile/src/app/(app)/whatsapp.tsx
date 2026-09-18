import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatCircleIcon as ChatCircle } from "phosphor-react-native/src/icons/ChatCircle";
import { ApiError } from "@matgary/api-client";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack } from "@/components/ui/Chevron";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";

/**
 * Port of mobile-fold/app__whatsapp.png — the web's /whatsapp inbox
 * (components/whatsapp/{ConversationList,ThreadView,MessageBubble}.tsx).
 *
 * Gate: `manage_whatsapp`, exactly like the web page (can(principal,
 * "manage_whatsapp")). Two in-screen views, swapped by local state instead of
 * the web's `?c=` search param:
 *  - Inbox: All/Unread/Archived tabs + conversation FlashList paged by the
 *    API's `before` cursor — exactly the mobile-fold PNG, no status card above
 *    the tabs. When no number is linked, the empty state carries the hint.
 *  - Thread: chat-style FlashList of message bubbles. FlashList v2 has no
 *    `inverted`; instead the rows are reversed to chronological order and
 *    `maintainVisibleContentPosition.startRenderingFromBottom` anchors the
 *    newest bubble at the bottom while older pages prepend at the top via
 *    `onStartReached`. Pull-to-refresh therefore sits at the oldest end (the
 *    top), where it shares a gesture with `onStartReached`; the latter is
 *    guarded on `!refreshing` so one pull is one request, not a refetch plus
 *    an older page. A composer POSTs /api/whatsapp/cloud/send — the same
 *    route the web ThreadView uses — and invalidates the thread.
 *
 * Connecting a number is NOT ported: the Meta OAuth dance needs a browser
 * session, so the disconnected empty state points at the web dashboard.
 */

type ConversationFilter = "all" | "unread" | "archived";

interface ConversationDTO {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  windowExpiresAt: string | null;
  archivedAt: string | null;
}

interface ConversationDetailDTO extends ConversationDTO {
  windowOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed" | null;

interface MessageDTO {
  id: string;
  direction: "inbound" | "outbound";
  messageType: string;
  textBody: string | null;
  mediaFilename: string | null;
  status: MessageStatus;
  sentAt: string | null;
  receivedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

interface ConnectionResponse {
  connected: boolean;
  connection: null | {
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: string;
    mode: string;
  };
}

interface ConversationsPage {
  ok: boolean;
  count: number;
  nextBefore: string | null;
  conversations: ConversationDTO[];
}

interface MessagesPage {
  messages: MessageDTO[];
  nextBefore: string | null;
}

const LIST_PAGE = 30;
const THREAD_PAGE = 50;
/** Same cadence as the web: ConversationList polls every 10s, ThreadView every 8s. */
const LIST_POLL_MS = 10_000;
const THREAD_POLL_MS = 8_000;

const MESSAGE_TYPE_KEYS = new Set([
  "image",
  "document",
  "video",
  "audio",
  "sticker",
  "location",
  "button_reply",
  "interactive_reply",
  "reaction",
  "template",
]);

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.message || fallback;
}

/** Same buckets as the web's format.ts relativeTime. */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return t("app.whatsappInbox.relative.now");
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t("app.whatsappInbox.relative.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("app.whatsappInbox.relative.hours", { n: hours });
  return t("app.whatsappInbox.relative.days", { n: Math.floor(hours / 24) });
}

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Mirrors the web's windowDisplay: which of the four window states applies. */
function windowLine(expiresAt: string | null): { text: string; open: boolean } {
  if (!expiresAt) return { text: t("app.whatsappInbox.windowState.noChat"), open: false };
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return { text: t("app.whatsappInbox.windowState.closed"), open: false };
  }
  if (remaining < 60 * 60 * 1000) {
    return { text: t("app.whatsappInbox.windowState.endingSoon"), open: true };
  }
  const h = Math.floor(remaining / (60 * 60 * 1000));
  return { text: t("app.whatsappInbox.windowState.openHours", { h }), open: true };
}

function messageText(m: { messageType: string; textBody: string | null; mediaFilename?: string | null }): string {
  if (m.textBody) return m.textBody;
  if (m.mediaFilename) return m.mediaFilename;
  const key = MESSAGE_TYPE_KEYS.has(m.messageType) ? m.messageType : "unknown";
  return t(`app.whatsappInbox.messageTypes.${key}`);
}

function conversationTitle(c: ConversationDTO): string {
  return c.displayName?.trim() || c.phoneNumber;
}

function initial(c: ConversationDTO): string {
  const name = c.displayName?.trim();
  if (name) return name.slice(0, 1).toUpperCase();
  return c.phoneNumber.replace(/\D/g, "").slice(-2) || "#";
}

// ---------------------------------------------------------------------------

export default function WhatsappScreen() {
  const me = useSession((s) => s.me);
  const allowed = new Set(me?.permissions ?? []);
  const canManage = allowed.has("manage_whatsapp");
  const [activeId, setActiveId] = useState<string | null>(null);

  if (!canManage) {
    return (
      <Screen title={t("app.whatsappInbox.title")}>
        <Card>
          <Text style={styles.notAllowed}>{t("app.whatsappInbox.notAllowed")}</Text>
        </Card>
      </Screen>
    );
  }

  if (activeId) {
    return <ThreadView key={activeId} conversationId={activeId} onBack={() => setActiveId(null)} />;
  }

  return <InboxView onSelect={setActiveId} />;
}

// ---------------------------------------------------------------------------
// Inbox

function InboxView({ onSelect }: { onSelect: (id: string) => void }) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [refreshing, setRefreshing] = useState(false);

  const connection = useQuery({
    queryKey: ["whatsapp", "connection"],
    queryFn: () => api.request<ConnectionResponse>("/api/whatsapp/connection"),
  });

  const list = useInfiniteQuery({
    queryKey: ["whatsapp", "conversations", filter],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", String(LIST_PAGE));
      if (filter === "unread") params.set("unread", "1");
      if (filter === "archived") params.set("includeArchived", "1");
      if (pageParam) params.set("before", pageParam);
      return api.request<ConversationsPage>(`/api/whatsapp/conversations?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: LIST_POLL_MS,
  });

  const refreshInbox = () => {
    setRefreshing(true);
    void Promise.all([list.refetch(), connection.refetch()]).finally(() => setRefreshing(false));
  };

  // Same client-side narrowing as the web ConversationList: the API's
  // includeArchived returns both, so "archived" keeps only archived rows and
  // "all" hides them.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: ConversationDTO[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const c of page.conversations) {
        if (seen.has(c.id)) continue;
        const keep =
          filter === "archived" ? !!c.archivedAt : filter === "unread" ? c.unreadCount > 0 : !c.archivedAt;
        if (!keep) continue;
        seen.add(c.id);
        out.push(c);
      }
    }
    return out;
  }, [list.data, filter]);

  const tabs: { key: ConversationFilter; label: string }[] = [
    { key: "all", label: t("app.whatsappInbox.tabs.all") },
    { key: "unread", label: t("app.whatsappInbox.tabs.unread") },
    { key: "archived", label: t("app.whatsappInbox.tabs.archived") },
  ];

  // Resolved and explicitly not linked — while pending or errored, say nothing.
  const disconnected = connection.data ? !connection.data.connected : false;

  const emptyText =
    filter === "unread"
      ? t("app.whatsappInbox.list.emptyUnread")
      : filter === "archived"
        ? t("app.whatsappInbox.list.emptyArchived")
        : t("app.whatsappInbox.list.emptyAll");

  const header = (
    <View style={styles.headerWrap}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t("app.whatsappInbox.title")}</Text>
      </View>
      <View style={styles.tabsRow}>
        {tabs.map((tab) => {
          const active = tab.key === filter;
          return (
            <Pressable
              key={tab.key}
              onPress={() => setFilter(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, active ? styles.tabLabelActive : styles.tabLabelInactive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const empty = list.isPending ? (
    <View style={[styles.centered, styles.listCardBody]}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : list.isError ? (
    <View style={[styles.centered, styles.listCardBody]}>
      <Text style={styles.errorText}>
        {t("app.whatsappInbox.list.errorPrefix")} {errorMessage(list.error, t("mobile.whatsapp.genericError"))}
      </Text>
      <Button label={t("mobile.whatsapp.retry")} variant="outline" onPress={() => list.refetch()} />
    </View>
  ) : (
    <View style={[styles.centered, styles.listCardBody]}>
      <ChatCircle size={64} color={colors.textSecondary} weight="regular" />
      <Text style={styles.emptyText}>{emptyText}</Text>
      {disconnected && filter === "all" ? (
        <Text style={styles.emptyHint}>{t("mobile.whatsapp.connectFromWeb")}</Text>
      ) : null}
    </View>
  );

  const footer = list.isFetchingNextPage ? (
    <View style={[styles.footer, styles.listCardBody]}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : null;

  return (
    <View style={styles.root}>
      <FlashList
        data={rows}
        keyExtractor={(c) => c.id}
        renderItem={({ item, index }) => (
          <ConversationRow
            c={item}
            last={index === rows.length - 1 && !list.isFetchingNextPage}
            onPress={() => onSelect(item.id)}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshInbox} />}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

function ConversationRow({ c, last, onPress }: { c: ConversationDTO; last: boolean; onPress: () => void }) {
  const unread = c.unreadCount > 0;
  const preview = c.lastMessagePreview
    ? (c.lastMessageDirection === "outbound" ? t("app.whatsappInbox.list.youPrefix") : "") + c.lastMessagePreview
    : "";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, last ? styles.rowLast : styles.rowDivider, pressed && styles.rowPressed]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initial(c)}</Text>
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowTitle, unread && styles.rowTitleUnread]} numberOfLines={1}>
            {conversationTitle(c)}
          </Text>
          <Text style={styles.rowTime}>{relativeTime(c.lastMessageAt)}</Text>
        </View>
        <View style={styles.rowTop}>
          <Text style={[styles.rowPreview, unread && styles.rowPreviewUnread]} numberOfLines={1}>
            {preview}
          </Text>
          {unread ? (
            <View style={styles.unreadDot}>
              <Text style={styles.unreadText}>{c.unreadCount > 99 ? "99+" : String(c.unreadCount)}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Thread

function ThreadView({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const conversation = useQuery({
    queryKey: ["whatsapp", "conversation", conversationId],
    queryFn: () =>
      api.request<{ ok: boolean; conversation: ConversationDetailDTO }>(
        `/api/whatsapp/conversations/${conversationId}`,
      ),
    refetchInterval: THREAD_POLL_MS,
  });

  const messages = useInfiniteQuery({
    queryKey: ["whatsapp", "messages", conversationId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", String(THREAD_PAGE));
      if (pageParam) params.set("before", pageParam);
      return api.request<MessagesPage>(
        `/api/whatsapp/conversations/${conversationId}/messages?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    // v5 refetches every loaded page in order; threads are one or two pages
    // of THREAD_PAGE, so this stays cheap and inbound replies land in ≤8s.
    refetchInterval: THREAD_POLL_MS,
  });

  const refreshThread = () => {
    setRefreshing(true);
    void Promise.all([messages.refetch(), conversation.refetch()]).finally(() => setRefreshing(false));
  };

  // The API (and each infinite page) is newest first; FlashList v2 has no
  // `inverted`, so flatten in API order, dedupe, then reverse to chronological
  // — the newest bubble is the last row and sits at the bottom thanks to
  // `startRenderingFromBottom`, and older pages prepend at the top.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: MessageDTO[] = [];
    for (const page of messages.data?.pages ?? []) {
      for (const m of page.messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
    }
    out.reverse();
    return out;
  }, [messages.data]);

  const invalidateInbox = () => {
    void qc.invalidateQueries({ queryKey: ["whatsapp", "conversations"] });
  };
  const invalidateThread = () => {
    void qc.invalidateQueries({ queryKey: ["whatsapp", "messages", conversationId] });
    void qc.invalidateQueries({ queryKey: ["whatsapp", "conversation", conversationId] });
  };

  // Opening the thread marks it read, like the web ThreadView's mount effect.
  useEffect(() => {
    void api
      .request(`/api/whatsapp/conversations/${conversationId}`, { method: "PATCH", body: { read: true } })
      .then(invalidateInbox)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const conv = conversation.data?.conversation ?? null;
  const window = windowLine(conv?.windowExpiresAt ?? null);
  const canSend = !!conv?.windowOpen;

  const send = useMutation({
    mutationFn: (message: string) =>
      api.request<{ ok: boolean; error?: string }>("/api/whatsapp/cloud/send", {
        method: "POST",
        body: { phone: conv?.phoneNumber ?? "", message },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        setError(res.error || t("mobile.whatsapp.genericError"));
        return;
      }
      setDraft("");
      setError(null);
      invalidateThread();
      invalidateInbox();
    },
    onError: (e) => setError(errorMessage(e, t("mobile.whatsapp.genericError"))),
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api.request(`/api/whatsapp/conversations/${conversationId}`, { method: "PATCH", body: { archived } }),
    onSuccess: () => {
      invalidateThread();
      invalidateInbox();
    },
    onError: (e) => setError(errorMessage(e, t("mobile.whatsapp.genericError"))),
  });

  const handleSend = () => {
    const text = draft.trim();
    if (!text || !conv || send.isPending) return;
    if (!canSend) {
      setError(t("app.whatsappInbox.thread.windowClosedError"));
      return;
    }
    send.mutate(text);
  };

  const older = messages.isFetchingNextPage ? (
    <View style={styles.footer}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : messages.hasNextPage ? (
    <Pressable
      onPress={() => void messages.fetchNextPage()}
      accessibilityRole="button"
      style={styles.loadOlder}
    >
      <Text style={styles.loadOlderText}>{t("app.whatsappInbox.thread.loadOlder")}</Text>
    </Pressable>
  ) : null;

  const empty = messages.isPending ? (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : messages.isError ? (
    <View style={styles.centered}>
      <Text style={styles.errorText}>
        {t("app.whatsappInbox.list.errorPrefix")}{" "}
        {errorMessage(messages.error, t("mobile.whatsapp.genericError"))}
      </Text>
      <Button label={t("mobile.whatsapp.retry")} variant="outline" onPress={refreshThread} />
    </View>
  ) : (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{t("app.whatsappInbox.thread.emptyMessages")}</Text>
    </View>
  );

  // The conversation GET failed before we ever had it (404, offline): the
  // header says so and offers a retry instead of sitting on "Loading…".
  const conversationFailed = !conv && conversation.isError;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.threadHeader, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t("app.whatsappInbox.thread.back")}
          hitSlop={8}
          style={styles.backBtn}
        >
          <ChevronBack size={22} color={colors.text} />
        </Pressable>
        <View style={styles.threadTitleBlock}>
          <Text style={styles.threadTitle} numberOfLines={1}>
            {conv
              ? conversationTitle(conv)
              : conversationFailed
                ? t("mobile.whatsapp.genericError")
                : t("app.whatsappInbox.thread.loading")}
          </Text>
          {conv ? (
            <Text style={[styles.threadSub, window.open ? styles.threadSubOpen : styles.threadSubClosed]}>
              {window.text}
            </Text>
          ) : conversationFailed ? (
            <Text style={[styles.threadSub, styles.threadSubError]} numberOfLines={2}>
              {errorMessage(conversation.error, t("mobile.whatsapp.genericError"))}
            </Text>
          ) : null}
        </View>
        {conv ? (
          <Pressable
            onPress={() => archive.mutate(!conv.archivedAt)}
            disabled={archive.isPending}
            accessibilityRole="button"
            hitSlop={8}
            style={styles.archiveBtn}
          >
            <Text style={styles.archiveText}>
              {conv.archivedAt ? t("app.whatsappInbox.thread.restore") : t("app.whatsappInbox.thread.archive")}
            </Text>
          </Pressable>
        ) : conversationFailed ? (
          <Pressable onPress={refreshThread} accessibilityRole="button" hitSlop={8} style={styles.archiveBtn}>
            <Text style={styles.archiveText}>{t("mobile.whatsapp.retry")}</Text>
          </Pressable>
        ) : null}
      </View>

      <FlashList
        data={rows}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageBubble m={item} />}
        // Rows are chronological, so "older" is the header (top) and older
        // pages are pulled by onStartReached — the mirror of the inverted
        // FlatList's ListFooterComponent + onEndReached.
        ListHeaderComponent={older}
        ListEmptyComponent={empty}
        // `!refreshing`: a pull-to-refresh happens at this same (oldest) end and
        // also satisfies FlashList's isNearStart, so without the guard one pull
        // fired fetchNextPage() alongside refreshThread()'s refetch of every
        // loaded page — two requests, and v5 cancels the refetch for the page
        // fetch. Re-arms once the pull settles; the header's "load older" button
        // covers the rare miss.
        onStartReached={() => {
          if (!refreshing && messages.hasNextPage && !messages.isFetchingNextPage) {
            void messages.fetchNextPage();
          }
        }}
        onStartReachedThreshold={0.3}
        // New arch only. Start scrolled to the newest bubble; when the user is
        // near the bottom and a new message lands, follow it; when older pages
        // prepend at the top, hold the visible bubble in place.
        maintainVisibleContentPosition={{
          startRenderingFromBottom: true,
          autoscrollToBottomThreshold: 0.2,
        }}
        // Pull-to-refresh lives at the top (the oldest end) — the inverted
        // FlatList had it beside the composer; chronological rows move it to
        // the standard chat position. Kept because a poll every THREAD_POLL_MS
        // is not "now": the pull is the owner's way to force it.
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshThread} />}
        contentContainerStyle={styles.threadContent}
        keyboardShouldPersistTaps="handled"
      />

      {error ? (
        <Pressable onPress={() => setError(null)} style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{error}</Text>
        </Pressable>
      ) : null}

      {/* No insets.bottom here: this is a Tabs.Screen and BottomNav below it already
          pads the home-indicator inset (see BottomNav.tsx). */}
      <View style={styles.composer}>
        {conv && !canSend ? (
          // not ported: the web follows this hint with a "Manage templates" link to
          // /settings — templates are managed on the web only, so the hint's trailing
          // space (meant to precede that link) is trimmed.
          <Text style={styles.outsideHint}>{t("app.whatsappInbox.thread.outsideWindowHint").trim()}</Text>
        ) : null}
        <View style={styles.composerRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t("app.whatsappInbox.thread.composerPlaceholder")}
            placeholderTextColor={colors.textSecondary}
            multiline
            maxLength={4000}
            editable={canSend && !send.isPending}
            style={[styles.input, !canSend && styles.inputDisabled]}
          />
          <Button
            label={t("app.whatsappInbox.thread.send")}
            onPress={handleSend}
            loading={send.isPending}
            disabled={!draft.trim() || !canSend}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ m }: { m: MessageDTO }) {
  const out = m.direction === "outbound";
  const time = clock(m.sentAt ?? m.receivedAt ?? m.createdAt);
  const failed = m.status === "failed";
  return (
    <View style={[styles.bubbleWrap, out ? styles.bubbleWrapOut : styles.bubbleWrapIn]}>
      <View style={[styles.bubble, out ? styles.bubbleOut : styles.bubbleIn, failed && styles.bubbleFailed]}>
        <Text style={styles.bubbleText}>{messageText(m)}</Text>
        <View style={styles.bubbleMeta}>
          <Text style={styles.bubbleTime}>{time}</Text>
          {out && m.status ? (
            <Text style={[styles.bubbleStatus, failed && styles.bubbleStatusFailed]}>
              {t(`app.whatsappInbox.messageStatus.${m.status}`)}
            </Text>
          ) : null}
        </View>
        {failed && m.failureReason ? <Text style={styles.failureReason}>{m.failureReason}</Text> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    flexGrow: 1,
  },
  headerWrap: { gap: spacing.lg },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  // "WhatsApp" is Latin, so bidi would left-anchor it inside an RTL page —
  // pin it to the header's start edge explicitly.
  // Shrink-wrap so Yoga places the Latin brand name at the reading edge; on
  // iOS Fabric `textAlign: "right"` is swapped to physical left under RTL.
  titleRow: { alignItems: "flex-start" },
  notAllowed: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: "center",
  },

  // Tabs are the top edge of the conversation card (mobile-fold PNG): rows and
  // the empty/footer views carry the side + bottom borders that close it.
  tabsRow: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.border,
    borderTopStartRadius: radius.lg,
    borderTopEndRadius: radius.lg,
    backgroundColor: colors.card,
  },
  listCardBody: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: colors.border,
    borderBottomStartRadius: radius.lg,
    borderBottomEndRadius: radius.lg,
  },
  tab: {
    flex: 1,
    minHeight: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 3,
    borderBottomColor: "transparent",
    marginBottom: -1,
  },
  tabActive: { borderBottomColor: colors.accent },
  tabLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 16 },
  tabLabelActive: { ...RTL_TEXT, color: colors.accent, fontFamily: fonts.semibold },
  tabLabelInactive: { color: colors.textSecondary },

  centered: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingVertical: spacing.xxl * 3,
    paddingHorizontal: spacing.lg,
  },
  emptyText: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textSecondary,
    textAlign: "center",
  },
  emptyHint: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    maxWidth: 300,
  },
  errorText: { fontFamily: fonts.regular, fontSize: 14, color: colors.danger, textAlign: "center" },
  footer: { paddingVertical: spacing.lg, alignItems: "center" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH + spacing.lg,
    backgroundColor: colors.card,
    borderStartWidth: 1,
    borderEndWidth: 1,
    borderColor: colors.border,
  },
  rowDivider: { borderBottomWidth: 1 },
  rowLast: {
    borderBottomWidth: 1,
    borderBottomStartRadius: radius.lg,
    borderBottomEndRadius: radius.lg,
  },
  rowPressed: { backgroundColor: colors.neutralTint },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 16, color: colors.accent },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  rowTitle: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowTitleUnread: { ...RTL_TEXT, fontFamily: fonts.semibold },
  rowTime: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  rowPreview: { flex: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  rowPreviewUnread: { color: colors.text },
  unreadDot: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 11, color: colors.card },

  threadHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  backBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  threadTitleBlock: { flex: 1, gap: 1 },
  threadTitle: { fontFamily: fonts.semibold, fontSize: 17, color: colors.text, ...RTL_TEXT },
  threadSub: { fontFamily: fonts.regular, fontSize: 12, ...RTL_TEXT },
  threadSubOpen: { color: colors.successStrong },
  threadSubClosed: { color: colors.warningStrong },
  threadSubError: { color: colors.danger },
  archiveBtn: { minHeight: MIN_TOUCH, justifyContent: "center", paddingHorizontal: spacing.sm },
  archiveText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.accent },

  threadContent: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flexGrow: 1 },
  loadOlder: {
    alignSelf: "center",
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  loadOlderText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.accent },

  bubbleWrap: { flexDirection: "row", marginVertical: 3 },
  bubbleWrapIn: { justifyContent: "flex-start" },
  bubbleWrapOut: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    gap: 2,
  },
  bubbleIn: { backgroundColor: colors.neutralTint, borderTopStartRadius: radius.md },
  bubbleOut: { backgroundColor: colors.accentLight, borderTopEndRadius: radius.md },
  bubbleFailed: { backgroundColor: colors.dangerLight },
  bubbleText: { fontFamily: fonts.regular, fontSize: 15, color: colors.text, ...RTL_TEXT },
  bubbleMeta: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: spacing.xs },
  bubbleTime: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  bubbleStatus: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  bubbleStatusFailed: { color: colors.danger },
  failureReason: { fontFamily: fonts.regular, fontSize: 12, color: colors.danger, ...RTL_TEXT },

  errorBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerLight,
  },
  errorBannerText: { fontFamily: fonts.regular, fontSize: 13, color: colors.danger, ...RTL_TEXT },

  composer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    gap: spacing.xs,
    ...elevation.card,
  },
  outsideHint: { fontFamily: fonts.regular, fontSize: 12, color: colors.warningStrong, ...RTL_TEXT },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
    ...RTL_TEXT,
  },
  inputDisabled: { backgroundColor: colors.neutralTint, color: colors.textSecondary },
});
