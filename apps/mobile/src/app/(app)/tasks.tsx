import { useState } from "react";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { useSession } from "@/stores/session";
import { shortDate } from "@/lib/format";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

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
  const open = rows.filter((task) => task.status !== "done");
  const done = rows.filter((task) => task.status === "done");

  return (
    <Screen
      title={t("app.tasks.page.title")}
      subtitle={rows.length ? t("mobile.tasks.summary", { open: open.length, done: done.length }) : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {canManageTasks ? (
        // "+ مهمة جديدة" in the capture draws the plus to the LEFT of the
        // words, which in an RTL paragraph is the END of the string — hence
        // the trailing sign here rather than a leading one.
        <Button label={t("mobile.tasks.newTask")} onPress={() => setFormOpen(true)} />
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
                    <Badge label={t("app.tasks.card.doneAction")} variant="success" />
                  ) : task.dueDate ? (
                    <Text style={styles.date}>{t("mobile.tasks.due", { date: shortDate(task.dueDate) })}</Text>
                  ) : null}
                </View>
                {/* What a tap does, spelled out. The web says it with two
                    buttons in the card footer; one tap target is the phone's
                    version of the same affordance. */}
                <View style={styles.footer}>
                  {pending ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Text numberOfLines={1} style={styles.action}>
                      {isDone ? t("app.tasks.card.reopenAction") : t("mobile.tasks.doneCheck")}
                    </Text>
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
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
              <Text style={styles.sheetTitle}>{t("app.tasks.toolbar.newTask")}</Text>

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

              <View style={styles.actions}>
                <Button
                  label={t("app.tasks.form.create")}
                  onPress={() => create.mutate()}
                  disabled={!canSubmit}
                  loading={create.isPending}
                  style={styles.actionGrow}
                />
                <Button
                  label={t("app.tasks.form.cancel")}
                  variant="outline"
                  onPress={close}
                  style={styles.actionGrow}
                />
              </View>
            </ScrollView>
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
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "90%",
    ...elevation.modal,
  },
  sheetBody: { padding: spacing.xl, gap: spacing.lg },
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
