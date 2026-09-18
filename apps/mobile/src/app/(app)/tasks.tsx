import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { XIcon as X } from "phosphor-react-native/src/icons/X";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { isRTL, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { UNREAD_TASKS_KEY, isOpenTask, useBadges } from "@/stores/badges";
import { useSession } from "@/stores/session";
import { shortDate } from "@/lib/format";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/** Measured pairs from doc 03 §2: عاجلة on danger-light, عادية on accent-light. */
const PRIORITY = (): Record<string, { label: string; variant: "outofstock" | "accent" | "neutral" }> => ({
  high: { label: t("app.tasks.priority.high"), variant: "outofstock" },
  normal: { label: t("app.tasks.priority.normal"), variant: "accent" },
  low: { label: t("app.tasks.priority.low"), variant: "neutral" },
});

/** The web's own order — ar.json → app.tasks.priority. */
const PRIORITY_ORDER: catalog.TaskPriority[] = ["low", "normal", "high"];

/**
 * ApiError → one Arabic line.
 *
 * These handlers answer a domain failure with a RAW Arabic string in `error`,
 * which the transport reads into `code` (and `message`) because it only treats
 * `detail` as prose. So: if the code is Arabic it IS the message and is shown
 * verbatim; anything else is a machine code the user must never see — "Forbidden"
 * on a cashier's task edit, for one — and is mapped by kind instead.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code && /[؀-ۿ]/.test(error.code)) return error.code;
  switch (error.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "rateLimited":
      return t("mobile.signup.tooMany");
    case "billing":
      return t("mobile.common.subscriptionInactive");
    case "server":
      return t("mobile.common.serverError");
    default:
      return fallback;
  }
}

/** Port of app__tasks.png. */
/** Local midnight — a task due yesterday is overdue, one due later today is not. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function TasksScreen() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["tasks"], queryFn: () => catalog.listTasks(api) });

  const me = useSession((s) => s.me);
  // POST /api/tasks checks `manage_tasks` inline (owners bypass). Showing the
  // button to a cashier would be offering a guaranteed 403.
  const canManageTasks = !!me && (me.isOwner || me.permissions.includes("manage_tasks"));
  // GET /api/team is manage_team-gated, so the assignee picker is only fetched
  // for someone allowed to read it. Without it the task is created unassigned,
  // which the route accepts.
  const canReadTeam = !!me && (me.isOwner || me.permissions.includes("manage_team"));

  const [formOpen, setFormOpen] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (task: { id: string; status: string }) =>
      catalog.setTaskStatus(api, task.id, task.status === "done" ? "open" : "done"),
    onMutate: () => setStatusError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
    onError: (err) => setStatusError(errorMessage(err, t("app.tasks.toast.statusFailed"))),
  });

  const rows = q.data ?? [];
  const open = rows.filter(isOpenTask);
  const done = rows.filter((task) => task.status === "done");

  // Doc 02 §1.1 row 14: this screen drives the bottom-nav badge — by clearing
  // it. Web parity (components/tasks/TasksTab.tsx:80): opening the tasks page
  // POSTs /api/tasks/seen (idempotent, requireTenant-only), then the badge
  // store drops to zero at once and everything under ["tasks"] — the list and
  // the bar's unread-count poll — re-fetches. Not gated on the store: the
  // count is 0 until the bar's first fetch answers, and a visit made before
  // that (or offline) must still count as "seen" the moment we are online.
  const markSeen = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.request<{ ok: true }>("/api/tasks/seen", { method: "POST" });
        // The server has marked them; the badge is wrong until it says so —
        // even if the user already left. Same seam the bar writes through,
        // so the two never disagree.
        queryClient.setQueryData(UNREAD_TASKS_KEY, { count: 0 });
        useBadges.getState().setTasksUnread(0);
        if (!cancelled) await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      } catch {
        // Best-effort, as on the web: the badge simply stays until the next visit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);
  // Every focus — this screen stays mounted under the Tabs navigator, so a
  // plain mount effect would fire once per session.
  useFocusEffect(markSeen);
  // A task assigned while this screen stays in front: the bar's poll lights
  // the badge, and it is cleared the moment it does rather than on re-focus.
  // Only a 0 → n step counts — the focus run above already covers a badge
  // that was lit on arrival, and our own reset (n → 0) must not post again.
  const focused = useIsFocused();
  const tasksUnread = useBadges((s) => s.tasksUnread);
  const prevUnread = useRef(tasksUnread);
  useEffect(() => {
    const prev = prevUnread.current;
    prevUnread.current = tasksUnread;
    if (!focused || tasksUnread === 0 || prev !== 0) return;
    return markSeen();
  }, [focused, tasksUnread, markSeen]);

  return (
    <Screen
      title={t("app.tasks.page.title")}
      subtitle={rows.length ? t("mobile.tasks.summary", { open: open.length, done: done.length }) : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {canManageTasks ? (
        // Verb + noun like every other list screen's CTA ("إضافة مصروف"); the
        // plus glyph that used to live in the string is gone — Button has no
        // icon slot, and a text "+" lands on the wrong side per direction.
        <Button label={t("app.tasks.toolbar.newTask")} onPress={() => setFormOpen(true)} />
      ) : null}

      {statusError ? (
        <Text numberOfLines={3} style={styles.error}>
          {statusError}
        </Text>
      ) : null}

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={canManageTasks ? t("app.tasks.empty.managerTitle") : t("app.tasks.empty.staffTitle")}
          hint={
            canManageTasks
              ? t("app.tasks.empty.managerHint")
              : t("app.tasks.empty.staffHint")
          }
        />
      ) : (
        <View style={styles.list}>
          {[...open, ...done].map((task) => {
            const p = PRIORITY()[task.priority] ?? { label: task.priority, variant: "neutral" as const };
            const isDone = task.status === "done";
            const overdue = !isDone && !!task.dueDate && new Date(task.dueDate).getTime() < startOfToday();
            const pending = toggle.isPending && toggle.variables?.id === task.id;
            return (
              <Pressable
                key={task.id}
                accessibilityRole="button"
                accessibilityState={{ checked: isDone, busy: pending }}
                accessibilityLabel={isDone ? t("mobile.tasks.reopenTitle", { title: task.title }) : t("mobile.tasks.completeTitle", { title: task.title })}
                disabled={pending}
                onPress={() => toggle.mutate({ id: task.id, status: task.status })}
                style={({ pressed }) => [
                  styles.row,
                  isDone && styles.rowDone,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.head}>
                  <Text numberOfLines={2} style={[styles.title, isDone && styles.titleDone]}>
                    {task.title}
                  </Text>
                  <Badge label={p.label} variant={p.variant} />
                </View>
                <View style={styles.meta}>
                  {isDone ? (
                    <Badge label={t("mobile.tasks.doneState")} variant="success" />
                  ) : task.dueDate ? (
                    <Text style={[styles.date, overdue && styles.dateOverdue]}>
                      {overdue
                        ? t("mobile.tasks.overdue", { date: shortDate(task.dueDate) })
                        : t("mobile.tasks.due", { date: shortDate(task.dueDate) })}
                    </Text>
                  ) : null}
                </View>
                {/* What a tap does, spelled out. The web says it with two
                    buttons in the card footer; one tap target is the phone's
                    version of the same affordance. */}
                <View style={styles.footer}>
                  {pending ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <View style={styles.actionRow}>
                      {isDone ? null : <Check size={14} color={colors.successStrong} weight="bold" />}
                      <Text numberOfLines={1} style={styles.action}>
                        {isDone ? t("app.tasks.card.reopenAction") : t("mobile.tasks.markDone")}
                      </Text>
                    </View>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      <TaskFormSheet
        visible={formOpen}
        canReadTeam={canReadTeam}
        onClose={() => setFormOpen(false)}
        onCreated={() => {
          setFormOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        }}
      />
    </Screen>
  );
}

/**
 * The web's TaskFormModal, minus the fields a phone cannot honestly offer yet
 * (see the report): title, description, assignee, priority.
 *
 * RTL is re-applied here on purpose: a Modal mounts its own native root, so the
 * `direction` set on the screen root does not reach inside it.
 */
function TaskFormSheet({
  visible,
  canReadTeam,
  onClose,
  onCreated,
}: {
  visible: boolean;
  canReadTeam: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [priority, setPriority] = useState<catalog.TaskPriority>("normal");
  const [error, setError] = useState<string | null>(null);

  const team = useQuery({
    queryKey: ["team"],
    queryFn: () => catalog.listTeam(api),
    enabled: visible && canReadTeam,
  });

  const canSubmit = title.trim().length > 0;

  const reset = () => {
    setTitle("");
    setDescription("");
    setAssignee(null);
    setPriority("normal");
    setError(null);
  };

  const create = useMutation({
    mutationFn: () =>
      catalog.createTask(api, {
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        assignedToUserId: assignee,
        priority,
      }),
    onSuccess: () => {
      reset();
      onCreated();
    },
    onError: (err) => setError(errorMessage(err, t("app.tasks.form.errors.saveFailed"))),
  });

  const close = () => {
    if (create.isPending) return;
    setError(null);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={[styles.overlay, directionStyle(isRTL())]}>
        {/* The KAV is the full-height flex-end container and the scrim sits
            INSIDE it: with an auto-height KAV the sheet's maxHeight resolved
            against its own content, clipping the CTAs at the bottom edge. */}
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.kav}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetScroll} contentContainerStyle={styles.sheetBody}>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>{t("app.tasks.toolbar.newTask")}</Text>
                <Pressable onPress={close} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t("app.common.close")}>
                  <X size={22} color={colors.text} />
                </Pressable>
              </View>

              <Field
                label={t("app.tasks.form.titleLabel")}
                value={title}
                onChangeText={setTitle}
                placeholder={t("app.tasks.form.titlePlaceholder")}
              />
              <Field
                label={t("app.tasks.form.descriptionLabel")}
                value={description}
                onChangeText={setDescription}
                placeholder={t("app.tasks.form.descriptionPlaceholder")}
                multiline
              />

              <View>
                <Text style={styles.label}>{t("app.tasks.form.priorityLabel")}</Text>
                <View style={styles.chipRow}>
                  {PRIORITY_ORDER.map((key) => (
                    <Chip
                      key={key}
                      label={PRIORITY()[key].label}
                      active={priority === key}
                      onPress={() => setPriority(key)}
                    />
                  ))}
                </View>
              </View>

              {canReadTeam ? (
                <View>
                  <Text style={styles.label}>{t("mobile.common.assignTo")}</Text>
                  {team.isLoading ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (team.data ?? []).length === 0 ? (
                    <Text style={styles.hint}>{t("mobile.common.noStaffYet")}</Text>
                  ) : (
                    <View style={styles.chipRow}>
                      {(team.data ?? []).map((m) => (
                        <Chip
                          key={m.userId}
                          label={`${m.displayName}${m.role === "owner" ? t("app.tasks.form.ownerSuffix") : ""}`}
                          active={assignee === m.userId}
                          onPress={() =>
                            setAssignee((cur) => (cur === m.userId ? null : m.userId))
                          }
                        />
                      ))}
                    </View>
                  )}
                </View>
              ) : null}

              {error ? (
                <Text numberOfLines={3} style={styles.error}>
                  {error}
                </Text>
              ) : null}

            </ScrollView>
            {/* Pinned footer with the home-indicator inset: inside the ScrollView
                the CTAs were clipped at the sheet's bottom edge. Cancel leads. */}
            <View style={[styles.actions, styles.sheetFooter, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
              <Button
                label={t("app.tasks.form.cancel")}
                variant="outline"
                onPress={close}
                style={styles.actionGrow}
              />
              <Button
                label={t("app.tasks.form.create")}
                onPress={() => create.mutate()}
                disabled={!canSubmit}
                loading={create.isPending}
                style={styles.actionGrow}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    ...elevation.card,
  },
  rowDone: { opacity: 0.6 },
  rowPressed: { borderColor: colors.accent },
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  titleDone: { textDecorationLine: "line-through" },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  date: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  dateOverdue: { color: colors.danger, fontFamily: fonts.medium },
  actionRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    minHeight: 32,
    justifyContent: "center",
  },
  action: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.successStrong,
    flexShrink: 0,
    ...RTL_TEXT,
  },

  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
  kav: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "90%",
    ...elevation.modal,
  },
  sheetScroll: { flexShrink: 1 },
  sheetBody: { padding: spacing.xl, gap: spacing.lg },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  closeBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", marginEnd: -spacing.sm, marginVertical: -spacing.sm },
  sheetFooter: { paddingHorizontal: spacing.xl, paddingTop: spacing.md },
  sheetTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  label: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  hint: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  error: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },
  actions: { flexDirection: "row", gap: spacing.sm },
  actionGrow: { flex: 1 },
});
