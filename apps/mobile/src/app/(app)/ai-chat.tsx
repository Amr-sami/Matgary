import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createMMKV } from "react-native-mmkv";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { PaperPlaneTiltIcon as PaperPlaneTilt } from "phosphor-react-native/src/icons/PaperPlaneTilt";
import { PaperclipIcon as Paperclip } from "phosphor-react-native/src/icons/Paperclip";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { ai, ApiError } from "@matgary/api-client";

import { api } from "@/api/client";
import { Block } from "@/components/ai/Block";
import { VoiceRecorder } from "@/components/ai/VoiceRecorder";
import { ChevronBack } from "@/components/ui/Chevron";
import { appendUnique, makeMessageId } from "@/lib/chatState";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Full-screen AI assistant chat ("اسأل عمرو"). The mobile side holds no API
 * key — every turn goes through POST /api/ai/chat on the Next.js backend
 * (apps/web/app/api/ai/chat/route.ts), which runs the full agent loop
 * (tool-calling, locale lock, render_* block composition).
 *
 * Persistence: MMKV, keyed by tenant id. Capped so a long thread doesn't
 * balloon the request body — the backend trims to 40, we cap at 30.
 */

const historyStore = createMMKV({ id: "ai-chat" });
const HISTORY_KEY_PREFIX = "history:v2:";
const MAX_MESSAGES = 30;

type UserMessage = {
  id: string;
  role: "user";
  content: string;
};

type AssistantMessage = {
  id: string;
  role: "assistant";
  blocks: ai.AiBlock[];
  /** F7 — the AI response locale (may differ from the mobile UI locale).
   *  Mobile UI chrome stays in the device's setting (ar/en); this is the
   *  language the server locked to for this turn's blocks. */
  locale: ai.AiResponse["locale"];
};

type ChatMessage = UserMessage | AssistantMessage;

function historyKey(tenantId: string | null): string | null {
  return tenantId ? `${HISTORY_KEY_PREFIX}${tenantId}` : null;
}

function loadHistory(tenantId: string | null): ChatMessage[] {
  const key = historyKey(tenantId);
  if (!key) return [];
  try {
    const raw = historyStore.getString(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m.id === "string" &&
        (m.role === "user" || m.role === "assistant"),
    );
  } catch {
    return [];
  }
}

function saveHistory(tenantId: string | null, messages: ChatMessage[]): void {
  const key = historyKey(tenantId);
  if (!key) return;
  try {
    historyStore.set(key, JSON.stringify(messages));
  } catch {
    // best effort — next successful write overwrites
  }
}

function clearHistory(tenantId: string | null): void {
  const key = historyKey(tenantId);
  if (!key) return;
  try {
    historyStore.remove(key);
  } catch {
    // ignore
  }
}

// makeId was a short `${Date.now()}_${rand6}` generator that collided under
// fast successive calls (two messages queued in the same ms would collide
// ~1 in 16M), which prevented the client from even DETECTING duplicates.
// All message ids now come from makeMessageId() — RFC-4122 v4 uuids.
const makeId = makeMessageId;

/** F6 — conversation id. The server uses it as the key for its
 *  per-conversation context store (Redis, 30-min TTL). Regenerated on
 *  every "new chat" so the previous conversation's references go away. */
const CONVERSATION_ID_PREFIX = "conversationId:";

function conversationIdKey(tenantId: string | null): string | null {
  return tenantId ? `${CONVERSATION_ID_PREFIX}${tenantId}` : null;
}

function loadOrCreateConversationId(tenantId: string | null): string {
  const key = conversationIdKey(tenantId);
  if (!key) return makeUuid();
  try {
    const existing = historyStore.getString(key);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch {
    /* fall through */
  }
  const fresh = makeUuid();
  try {
    historyStore.set(key, fresh);
  } catch {
    /* best effort */
  }
  return fresh;
}

function rotateConversationId(tenantId: string | null): string {
  const key = conversationIdKey(tenantId);
  const fresh = makeUuid();
  if (key) {
    try {
      historyStore.set(key, fresh);
    } catch {
      /* ignore */
    }
  }
  return fresh;
}

/** RFC 4122 v4 uuid using the crypto-grade Math.random (good enough for a
 *  client-side conversation key — the server trusts it ONLY as a cache key,
 *  not as auth). */
function makeUuid(): string {
  const hex = "0123456789abcdef";
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const s = bytes.map((b) => hex[(b >> 4) & 0xf]! + hex[b & 0xf]!).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Collapse an assistant message's blocks into a single text string the server
 * can read as history. The server treats this as prior-turn context, not as
 * display content, so lossy summarisation is fine — the model only needs to
 * remember what it already told the user.
 */
function blocksToHistoryText(blocks: ai.AiBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "text":
        parts.push(b.text);
        break;
      case "chart":
        parts.push(`[chart: ${b.title}]`);
        break;
      case "table":
        parts.push(`[table: ${b.title}, ${b.rows.length} rows]`);
        break;
      case "kpi":
        parts.push(`[kpi: ${b.items.map((i) => `${i.label}=${i.value}`).join(", ")}]`);
        break;
      case "confirmation":
        parts.push(`[awaiting confirmation: ${b.title}]`);
        break;
      case "product_card":
        parts.push(`[product_card: ${b.name} · ${b.price} ${b.currency}]`);
        break;
      case "clarification":
        parts.push(`[clarification: ${b.title} · ${b.options.length} options]`);
        break;
      case "comparison":
        parts.push(`[comparison: ${b.title} · ${b.entities.length} entities]`);
        break;
      case "inventory_summary":
        parts.push(
          `[inventory_summary: ${b.totalProducts} total, ${b.lowStockCount} low, ${b.outOfStockCount} oos]`,
        );
        break;
      case "sales_summary":
        parts.push(
          `[sales_summary: ${b.periodLabel} · revenue=${b.revenue} orders=${b.orders}]`,
        );
        break;
      case "warning":
        parts.push(`[warning:${b.severity}:${b.code}: ${b.title}]`);
        break;
      case "knowledge_answer":
        parts.push(
          `[knowledge_answer: ${b.answer.slice(0, 200)} · sources=${b.sources.length}]`,
        );
        break;
      case "rollback_preview":
        parts.push(`[rollback_preview: ${b.title}]`);
        break;
      case "rollback_result":
        parts.push(`[rollback_result: ${b.title}]`);
        break;
      case "rollback_conflict":
        parts.push(`[rollback_conflict:${b.kind_detail}: ${b.title}]`);
        break;
      case "import_preview":
        parts.push(
          `[import_preview: session=${b.sessionId.slice(0, 8)}… file=${b.fileName} create=${b.toCreate} update=${b.toUpdate} issues=${b.invalid + b.missing + b.ambiguous}]`,
        );
        break;
      case "import_question":
        parts.push(
          `[import_question: session=${b.sessionId.slice(0, 8)}… questions=${b.questions.length}]`,
        );
        break;
      case "import_result":
        parts.push(
          `[import_result: created=${b.created} updated=${b.updated} skipped=${b.skipped} failed=${b.failed} group=${b.operationGroupId?.slice(0, 8) ?? "n/a"}]`,
        );
        break;
      case "import_conflict":
        parts.push(
          `[import_conflict: reversed=${b.reversed} conflicted=${b.conflicted} failed=${b.failed}]`,
        );
        break;
      case "bulk_preview":
        parts.push(
          `[bulk_preview: ${b.mode} ${b.value} · matched=${b.totalMatched} eligible=${b.totalEligible} totalDelta=${b.totalPriceDelta}]`,
        );
        break;
      case "bulk_result":
        parts.push(
          `[bulk_result: updated=${b.updated} skipped=${b.skipped} failed=${b.failed}]`,
        );
        break;
    }
  }
  return parts.join("\n");
}

const SUGGESTION_KEYS = [
  "topBrand",
  "revenueTrend",
  "slowStock",
  "topCustomers",
  "profit",
  "online",
] as const;

export default function AiChatScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tenantId = useSession((s) => s.me?.tenant.id ?? null);

  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(tenantId));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // F6 — conversation id. Stable across turns; rotated on "new chat".
  const [conversationId, setConversationId] = useState(() => loadOrCreateConversationId(tenantId));
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    setMessages(loadHistory(tenantId));
    setConversationId(loadOrCreateConversationId(tenantId));
    setError(null);
  }, [tenantId]);

  useEffect(() => {
    saveHistory(tenantId, messages);
  }, [tenantId, messages]);

  const chat = useMutation({
    // RETRY DISABLED — React-Query's default `retry: 3` fires onSuccess once
    // per successful attempt, so a transient error followed by a success
    // doubled the assistant message. The server has its own retry/fallback
    // logic; an outer client retry would also duplicate server-side work
    // (the chat route is NOT idempotent — it writes operations and pending
    // actions). onError surfaces the failure for an explicit user retry.
    retry: 0,
    mutationFn: (history: ChatMessage[]) =>
      ai.chat(api, {
        messages: history.map((m) =>
          m.role === "user"
            ? { role: "user" as const, content: m.content }
            : { role: "assistant" as const, content: blocksToHistoryText(m.blocks) || "…" },
        ),
        conversationId,
      }),
    onSuccess: (res) => {
      const blocks = res.blocks.length > 0 ? res.blocks : [{ kind: "text" as const, text: "…" }];
      // Prefer the server-minted turnId. It's the same stable identity the
      // server threads through every internal event (tool calls, retries,
      // future streaming), so any double-delivery lands on the same id and
      // appendUnique silently drops the second copy.
      const msg: ChatMessage = {
        id: res.turnId ?? makeId(),
        role: "assistant",
        blocks,
        locale: res.locale,
      };
      // appendUnique drops the write if the id already exists — belt +
      // braces defence against double-fire onSuccess (e.g. React 18 strict
      // mode or a future retry re-enable).
      setMessages((prev) => appendUnique(prev, msg));
    },
    onError: (e) => {
      // Four distinct states the user can act on differently:
      //   • AI_DISABLED  — server has no key (owner action)
      //   • AI_BUSY      — Groq TPM rate-limit (brief wait, then retry)
      //   • timeout      — our 90s ceiling hit (server likely still working;
      //                    retrying immediately would duplicate work on Groq)
      //   • else         — real failure (surface generic message)
      const kind = e instanceof ApiError ? e.kind : null;
      const code = e instanceof ApiError ? e.code : null;
      setError(
        code === "AI_DISABLED"
          ? t("mobile.insights.ai.errorDisabled")
          : code === "AI_BUSY"
            ? t("mobile.insights.ai.errorBusy")
            : kind === "timeout"
              ? t("mobile.insights.ai.errorTimeout")
              : t("mobile.insights.ai.errorFailed"),
      );
    },
  });

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || chat.isPending) return;
      setError(null);
      const userMsg: UserMessage = { id: makeId(), role: "user", content: trimmed };
      // appendUnique: a rapid double-tap on send can't double-add the same id.
      const next = appendUnique(messages, userMsg).slice(-MAX_MESSAGES);
      setMessages(next);
      setDraft("");
      chat.mutate(next);
    },
    [chat, messages],
  );

  /* ─────────────────────── F10.1.1 — file import ────────────────────── */

  // Client-side size cap. Server also enforces 2 MiB; we reject earlier for UX.
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
  const SUPPORTED_EXTS = [".csv", ".xlsx"];

  const uploading = useMutation({
    // Upload is NOT idempotent on the server (ingestFile parses + persists
    // an ai_import_sessions row), so a React-Query retry would double-upload.
    // The session dedupe key is (tenant, fileHash, entityType) so the second
    // upload would be rejected, but we still shouldn't trigger the HTTP work.
    retry: 0,
    mutationFn: async (pick: { uri: string; name: string; mimeType: string; size: number }) => {
      const bodyBase64 = await FileSystem.readAsStringAsync(pick.uri, {
        encoding: "base64",
      });
      return ai.importUpload(api, {
        fileName: pick.name,
        mimeType: pick.mimeType,
        bodyBase64,
        conversationId,
      });
    },
    onSuccess: (res, variables) => {
      // Add a user-facing message describing the upload, then auto-ask the
      // agent to inspect — the backend does the heavy lifting.
      const userMsg: UserMessage = {
        id: makeId(),
        role: "user",
        content: t("mobile.insights.ai.import.userTurn", {
          file: variables.name,
          sessionId: res.sessionId,
        }),
      };
      const next = appendUnique(messages, userMsg).slice(-MAX_MESSAGES);
      setMessages(next);
      chat.mutate(next);
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : null;
      setError(
        code === "FILE_TOO_LARGE"
          ? t("mobile.insights.ai.import.fileTooLarge")
          : code === "UNSUPPORTED_FORMAT" || code === "MIME_MISMATCH"
            ? t("mobile.insights.ai.import.unsupportedFile")
            : code === "AI_DISABLED"
              ? t("mobile.insights.ai.errorDisabled")
              : t("mobile.insights.ai.import.uploadFailed"),
      );
    },
  });

  const pickFile = useCallback(async () => {
    if (uploading.isPending || chat.isPending) return;
    setError(null);
    const pick = await DocumentPicker.getDocumentAsync({
      // iOS inspects uniform type identifiers via `type` strings; we pass
      // MIME-adjacent and let the OS resolve + show xlsx/csv files.
      type: [
        "text/csv",
        "text/comma-separated-values",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
      ],
      multiple: false,
      copyToCacheDirectory: true, // required so expo-file-system can read it
    });
    if (pick.canceled) return;
    const asset = pick.assets?.[0];
    if (!asset) return;

    const name = asset.name ?? "upload";
    const lower = name.toLowerCase();
    const okExt = SUPPORTED_EXTS.some((e) => lower.endsWith(e));
    if (!okExt) {
      setError(t("mobile.insights.ai.import.unsupportedFile"));
      return;
    }
    const size = Number(asset.size ?? 0);
    if (size > MAX_UPLOAD_BYTES) {
      setError(t("mobile.insights.ai.import.fileTooLarge"));
      return;
    }
    if (!asset.uri) {
      setError(t("mobile.insights.ai.import.uploadFailed"));
      return;
    }
    // Pick a sensible MIME when the picker didn't give us one (iOS rarely does).
    const mimeType =
      asset.mimeType ??
      (lower.endsWith(".csv")
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    uploading.mutate({ uri: asset.uri, name, mimeType, size });
  }, [chat.isPending, uploading, t, messages, conversationId]);

  const onClear = () => {
    clearHistory(tenantId);
    setMessages([]);
    setError(null);
    // F6 — new chat = fresh conversation id so server-side context starts clean.
    setConversationId(rotateConversationId(tenantId));
  };

  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [messages.length, chat.isPending]);

  const canSend = draft.trim().length > 0 && !chat.isPending;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("app.common.back")}
          style={styles.headerBtn}
        >
          <ChevronBack size={22} color={colors.onAccent} />
        </Pressable>
        <View style={styles.headerTitleBlock}>
          <View style={styles.headerBadge}>
            <Image
              source={require("../../../assets/images/amr.png")}
              style={styles.headerBadgeImage}
            />
          </View>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {t("mobile.insights.ai.screenTitle")}
          </Text>
        </View>
        <Pressable
          onPress={onClear}
          disabled={messages.length === 0}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.insights.ai.newChat")}
          style={({ pressed }) => [
            styles.headerBtn,
            messages.length === 0 && styles.headerBtnMuted,
            pressed && styles.headerBtnPressed,
          ]}
        >
          <Trash size={20} color={colors.onAccent} />
        </Pressable>
      </View>

      {messages.length === 0 ? (
        <EmptyGreeting onPickSuggestion={send} disabled={chat.isPending} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MessageRow
              message={item}
              conversationId={conversationId}
              onConfirmResult={(blocks) => {
                if (!blocks) return; // user cancelled, nothing to append
                const msg: ChatMessage = {
                  id: makeId(),
                  role: "assistant",
                  blocks,
                  locale: item.role === "assistant" ? item.locale : "en",
                };
                setMessages((prev) => appendUnique(prev, msg));
              }}
              onFollowUp={send}
            />
          )}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{
            minIndexForVisible: 0,
            autoscrollToTopThreshold: 10,
          }}
          ListFooterComponent={
            chat.isPending ? (
              <View style={styles.thinkingRow}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.thinkingText}>
                  {t("mobile.insights.ai.thinking")}
                </Text>
              </View>
            ) : null
          }
        />
      )}

      {error ? (
        <Pressable
          onPress={() => setError(null)}
          accessibilityRole="button"
          accessibilityLabel={error}
          style={styles.errorBanner}
        >
          <Text style={styles.errorBannerText}>{error}</Text>
        </Pressable>
      ) : null}

      <View style={[styles.composer, { paddingBottom: Math.max(spacing.sm, insets.bottom) }]}>
        {uploading.isPending ? (
          <View style={styles.uploadingRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.uploadingText}>
              {t("mobile.insights.ai.import.uploading")}
            </Text>
          </View>
        ) : null}
        <View style={styles.composerRow}>
          <Pressable
            onPress={pickFile}
            disabled={uploading.isPending || chat.isPending}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.insights.ai.import.chooseFile")}
            style={({ pressed }) => [
              styles.attachBtn,
              (uploading.isPending || chat.isPending) && styles.attachBtnDisabled,
              pressed && styles.attachBtnPressed,
            ]}
          >
            <Paperclip size={20} color={colors.accent} />
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t("mobile.insights.ai.inputPlaceholder")}
            placeholderTextColor={colors.textSecondary}
            multiline
            maxLength={2000}
            editable={!chat.isPending && !uploading.isPending}
            style={styles.input}
            onSubmitEditing={() => send(draft)}
            blurOnSubmit={false}
            returnKeyType="send"
          />
          {/* Voice input — the transcript lands in `draft`; the user then
              edits (if they want) and taps the regular Send button. Voice
              is purely an input modality: no business logic here, the
              existing Agent handles the text exactly as if it were typed. */}
          <VoiceRecorder
            disabled={chat.isPending || uploading.isPending}
            onTranscript={(text) => {
              // Append to existing draft if the user already started typing,
              // otherwise set it. A trailing space keeps the two segments
              // visually separated when the user keeps editing.
              setDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
            }}
          />
          <Pressable
            onPress={() => send(draft)}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.insights.ai.send")}
            style={({ pressed }) => [
              styles.sendBtn,
              !canSend && styles.sendBtnDisabled,
              pressed && canSend && styles.sendBtnPressed,
            ]}
          >
            {/* Always the paper-plane icon. The dedicated "Thinking…" row
                above is the request-in-flight indicator; a second spinner on
                the button is noise. Button just dims via `sendBtnDisabled`
                while `chat.isPending` is true. */}
            <PaperPlaneTilt size={20} color={colors.onAccent} weight="fill" />
          </Pressable>
        </View>
        <Text style={styles.disclaimer}>
          {t("mobile.insights.ai.disclaimer")}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

/* ------------------------------------------------------------- subcomponents */

function MessageRow({
  message,
  conversationId,
  onConfirmResult,
  onFollowUp,
}: {
  message: ChatMessage;
  conversationId?: string;
  onConfirmResult?: (blocks: ai.AiBlock[] | null) => void;
  onFollowUp?: (text: string) => void;
}) {
  if (message.role === "user") {
    return (
      <View style={userStyles.row}>
        <View style={userStyles.bubble}>
          <Text style={userStyles.text}>{message.content}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={assistantStyles.wrap}>
      {message.blocks.map((b, i) => (
        <Block
          key={i}
          block={b}
          conversationId={conversationId}
          onConfirmResult={onConfirmResult}
          onFollowUp={onFollowUp}
        />
      ))}
    </View>
  );
}

function EmptyGreeting({
  onPickSuggestion,
  disabled,
}: {
  onPickSuggestion: (text: string) => void;
  disabled: boolean;
}) {
  const suggestions = useMemo(
    () =>
      SUGGESTION_KEYS.map((k) => ({
        key: k,
        text: t(`mobile.insights.ai.suggested.${k}`),
      })),
    [],
  );
  return (
    <View style={styles.greetingWrap}>
      <View style={styles.greetingIcon}>
        <Image
          source={require("../../../assets/images/amr.png")}
          style={styles.greetingIconImage}
        />
      </View>
      <Text style={styles.greetingTitle}>
        {t("mobile.insights.ai.greetingTitle")}
      </Text>
      <Text style={styles.greetingSub}>
        {t("mobile.insights.ai.greetingSub")}
      </Text>
      <View style={styles.suggestionList}>
        {suggestions.map((s) => (
          <Pressable
            key={s.key}
            onPress={() => onPickSuggestion(s.text)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={s.text}
            style={({ pressed }) => [
              styles.suggestionChip,
              pressed && !disabled && styles.suggestionChipPressed,
              disabled && styles.suggestionChipDisabled,
            ]}
          >
            <Text numberOfLines={2} style={styles.suggestionText}>
              {s.text}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ---------------------------------------------------------------- styles */

const userStyles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "flex-end" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderBottomRightRadius: 4,
    backgroundColor: colors.accent,
  },
  text: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.onAccent,
  },
});

const assistantStyles = StyleSheet.create({
  wrap: {
    gap: spacing.sm,
    // Pin assistant blocks to the start edge so a 92%-wide chart still reads
    // as "from Amr", not centred.
    alignItems: "stretch",
  },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  headerBtnMuted: { opacity: 0.4 },
  headerBtnPressed: { opacity: 0.6 },
  headerTitleBlock: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  headerBadge: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerBadgeImage: { width: 32, height: 32, resizeMode: "contain" },
  headerTitle: {
    ...RTL_TEXT,
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.onAccent,
  },

  listContent: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },

  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  thinkingText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },

  greetingWrap: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    alignItems: "center",
    gap: spacing.sm,
  },
  greetingIcon: {
    width: 96,
    height: 96,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  greetingIconImage: { width: 96, height: 96, resizeMode: "contain" },
  greetingTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 20,
    color: colors.text,
    textAlign: "center",
  },
  greetingSub: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.md,
    maxWidth: 340,
  },
  suggestionList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "center",
    maxWidth: 460,
  },
  suggestionChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: "100%",
  },
  suggestionChipPressed: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  suggestionChipDisabled: { opacity: 0.5 },
  suggestionText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
  },

  composer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  input: {
    ...RTL_TEXT,
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? spacing.sm : spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.neutralTint,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.card,
  },
  sendBtnDisabled: { backgroundColor: colors.textSecondary, opacity: 0.5 },
  sendBtnPressed: { opacity: 0.85 },

  // F10.1.1 — attach (file-picker) button sits to the left of the input.
  attachBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  attachBtnDisabled: { opacity: 0.4 },
  attachBtnPressed: { opacity: 0.7 },

  uploadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  uploadingText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },

  disclaimer: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    textAlign: "center",
    paddingTop: spacing.xs,
  },

  errorBanner: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.dangerLight,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorBannerText: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.danger,
  },
});
