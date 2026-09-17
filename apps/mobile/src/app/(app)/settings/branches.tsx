import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@matgary/api-client";
import {
  Eye,
  EyeSlash,
  PencilSimple,
  Storefront,
  Trash,
} from "phosphor-react-native";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack } from "@/components/ui/Chevron";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__settings-branches.png.
 *
 * This is the screen that makes `X-Branch-Id` real. On the web a switch is a
 * POST to /api/branches/select that flips an HttpOnly cookie and reloads the
 * page; on native there is no cookie — the branch is a request header the
 * session store owns. So "فتح" calls `useSession().switchBranch(id)`, which
 * sets the header, re-reads /me and keeps whatever branch the SERVER resolved
 * (see stores/session.ts) — then every cached query is invalidated, because
 * every list in this app is branch-scoped and is now answering for the wrong
 * one.
 */
interface BranchRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  isPrimary: boolean;
}

interface Draft {
  id: string | null;
  name: string;
  address: string;
  phone: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: "", address: "", phone: "" };

async function listBranches(): Promise<BranchRow[]> {
  const res = await api.request<{ data: BranchRow[] }>("/api/branches");
  return res.data ?? [];
}

export default function BranchesScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const switchBranch = useSession((s) => s.switchBranch);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const q = useQuery({ queryKey: ["branches"], queryFn: listBranches });

  /**
   * /me already carries every branch this user may switch to, so the list is
   * never empty just because the extra GET failed — it degrades to name +
   * primary flag, which is all the switch itself needs.
   */
  const rows: BranchRow[] =
    q.data ??
    (me?.branches ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      address: null,
      phone: null,
      isActive: true,
      isPrimary: b.isPrimary,
    }));

  const currentId = me?.branch.id ?? null;
  const isOwner = me?.isOwner ?? false;

  const fail = (error: unknown, fallback: string) => {
    const text =
      error instanceof ApiError
        ? error.kind === "forbidden"
          ? t("mobile.common.ownerOnly")
          : error.kind === "offline"
            ? t("mobile.common.offline")
            : fallback
        : fallback;
    setNotice({ tone: "err", text });
  };

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name.trim(),
        address: d.address.trim() || null,
        phone: d.phone.trim() || null,
      };
      if (d.id) {
        await api.request(`/api/branches/${d.id}`, { method: "PATCH", body });
      } else {
        await api.request("/api/branches", { method: "POST", body });
      }
    },
    onSuccess: (_data, d) => {
      setNotice({ tone: "ok", text: d.id ? t("app.branchesPage.toast.edited") : t("app.branchesPage.toast.created") });
      setDraft(null);
      void q.refetch();
    },
    onError: (e) => fail(e, t("app.branchesPage.toast.saveFailed")),
  });

  const toggleActive = useMutation({
    mutationFn: (b: BranchRow) =>
      api.request(`/api/branches/${b.id}`, {
        method: "PATCH",
        body: { isActive: !b.isActive },
      }),
    onSuccess: (_d, b) => {
      setNotice({ tone: "ok", text: b.isActive ? t("app.branchesPage.toast.suspended") : t("app.branchesPage.toast.activated") });
      void q.refetch();
    },
    onError: (e) => fail(e, t("app.branchesPage.toast.updateFailed")),
  });

  const remove = useMutation({
    mutationFn: (b: BranchRow) =>
      api.request(`/api/branches/${b.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setNotice({ tone: "ok", text: t("app.branchesPage.toast.deleted") });
      void q.refetch();
    },
    onError: (e) => fail(e, t("app.branchesPage.toast.deleteFailed")),
  });

  const switching = useMutation({
    mutationFn: (id: string) => switchBranch(id),
    onSuccess: () => {
      setNotice({ tone: "ok", text: t("mobile.settings.switched") });
      // Everything on screen elsewhere is branch-scoped and now stale.
      void qc.invalidateQueries();
    },
    onError: (e) => fail(e, t("app.branchesPage.toast.switchFailed")),
  });

  const busy =
    save.isPending ||
    toggleActive.isPending ||
    remove.isPending ||
    switching.isPending;

  const confirmDelete = (b: BranchRow) => {
    if (b.isPrimary) {
      setNotice({ tone: "err", text: t("app.branchesPage.toast.primaryDelete") });
      return;
    }
    Alert.alert(
      t("app.branchesPage.actions.delete"),
      t("mobile.settings.deleteBranchConfirm", { name: b.name }),
      [
        { text: t("app.branchesPage.cancel"), style: "cancel" },
        { text: t("app.branchesPage.actions.delete"), style: "destructive", onPress: () => remove.mutate(b) },
      ],
    );
  };

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
        >
          {/* Back points RIGHT in an RTL page — the mirror of CaretLeft. */}
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>

        <View style={styles.titleRow}>
          <Text style={styles.title}>{t("app.branchesPage.heading")}</Text>
          {isOwner && !draft ? (
            <Button
              label={t("mobile.settings.addBranch")}
              onPress={() => setDraft({ ...EMPTY_DRAFT })}
              disabled={busy}
              style={styles.addButton}
            />
          ) : null}
        </View>
        <Text style={styles.subtitle}>
          {t("app.branchesPage.subhead")}
        </Text>
      </View>

      {notice ? (
        <Pressable onPress={() => setNotice(null)}>
          <Text
            style={[
              styles.notice,
              notice.tone === "ok" ? styles.noticeOk : styles.noticeErr,
            ]}
          >
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {draft ? (
        <Card title={draft.id ? t("app.branchesPage.editTitle") : t("app.branchesPage.newTitle")}>
          <View style={styles.form}>
            <Field
              label={t("app.branchesPage.nameLabel")}
              value={draft.name}
              onChangeText={(v) => setDraft({ ...draft, name: v })}
              placeholder={t("app.branchesPage.namePlaceholder")}
              editable={!busy}
            />
            <Field
              label={t("app.branchesPage.phoneLabel")}
              value={draft.phone}
              onChangeText={(v) => setDraft({ ...draft, phone: v })}
              placeholder="01XXXXXXXXX"
              keyboardType="phone-pad"
              editable={!busy}
            />
            <Field
              label={t("app.branchesPage.addressLabel")}
              value={draft.address}
              onChangeText={(v) => setDraft({ ...draft, address: v })}
              placeholder={t("app.branchesPage.addressPlaceholder")}
              editable={!busy}
            />
            <View style={styles.formActions}>
              <Button
                label={t("app.branchesPage.cancel")}
                variant="ghost"
                onPress={() => setDraft(null)}
                disabled={busy}
                style={styles.flex1}
              />
              <Button
                label={draft.id ? t("app.branchesPage.saveChanges") : t("app.branchesPage.create")}
                onPress={() => {
                  if (!draft.name.trim()) {
                    setNotice({ tone: "err", text: t("app.branchesPage.toast.nameRequired") });
                    return;
                  }
                  save.mutate(draft);
                }}
                loading={save.isPending}
                disabled={busy}
                style={styles.flex1}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {q.isLoading && rows.length === 0 ? (
        <ActivityIndicator color={colors.accent} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("app.branchesPage.empty")} />
      ) : (
        <View style={styles.list}>
          {rows.map((b) => {
            const isCurrent = b.id === currentId;
            return (
              <Card key={b.id}>
                <View style={styles.row}>
                  <View style={[styles.avatar, !b.isActive && styles.avatarOff]}>
                    <Storefront
                      size={18}
                      color={b.isActive ? colors.accent : colors.textSecondary}
                    />
                  </View>
                  <View style={styles.rowBody}>
                    <View style={styles.nameRow}>
                      <Text numberOfLines={1} style={styles.name}>
                        {b.name}
                      </Text>
                      {b.isPrimary ? <Badge label={t("app.branchesPage.labels.primary")} variant="accent" /> : null}
                      {isCurrent ? (
                        <Badge label={t("app.branchesPage.labels.current")} variant="success" />
                      ) : null}
                      {!b.isActive ? <Badge label={t("app.branchesPage.labels.suspended")} /> : null}
                    </View>
                    {b.address ? (
                      <Text numberOfLines={1} style={styles.meta}>
                        {b.address}
                      </Text>
                    ) : null}
                    {b.phone ? (
                      <Text numberOfLines={1} style={styles.metaLtr}>
                        {b.phone}
                      </Text>
                    ) : null}
                  </View>
                </View>

                <View style={styles.actions}>
                  {!isCurrent && b.isActive ? (
                    <Button
                      label={t("app.branchesPage.actions.open")}
                      onPress={() => switching.mutate(b.id)}
                      loading={switching.isPending && switching.variables === b.id}
                      disabled={busy}
                      style={styles.flex1}
                    />
                  ) : (
                    <View style={styles.flex1} />
                  )}

                  {isOwner ? (
                    <>
                      <IconButton
                        label={t("app.branchesPage.actions.edit")}
                        disabled={busy}
                        onPress={() =>
                          setDraft({
                            id: b.id,
                            name: b.name,
                            address: b.address ?? "",
                            phone: b.phone ?? "",
                          })
                        }
                      >
                        <PencilSimple size={18} color={colors.textSecondary} />
                      </IconButton>

                      <IconButton
                        label={b.isActive ? t("app.branchesPage.actions.suspend") : t("app.branchesPage.actions.activate")}
                        disabled={busy || b.isPrimary}
                        onPress={() => toggleActive.mutate(b)}
                      >
                        {b.isActive ? (
                          <EyeSlash size={18} color={colors.textSecondary} />
                        ) : (
                          <Eye size={18} color={colors.successStrong} />
                        )}
                      </IconButton>

                      <IconButton
                        label={t("app.branchesPage.actions.delete")}
                        disabled={busy || b.isPrimary}
                        onPress={() => confirmDelete(b)}
                      >
                        <Trash size={18} color={colors.textSecondary} />
                      </IconButton>
                    </>
                  ) : null}
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

function IconButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && styles.iconButtonPressed,
        disabled && styles.iconButtonDisabled,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Mirrors Screen's own header block; rendered here so the back link can sit
  // ABOVE the title instead of below it.
  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, flexShrink: 1, ...RTL_TEXT },
  addButton: { flexShrink: 0, minHeight: MIN_TOUCH, paddingHorizontal: spacing.lg },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },

  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  noticeOk: { backgroundColor: colors.successLight, color: colors.successStrong },
  noticeErr: { backgroundColor: colors.dangerLight, color: colors.danger },

  form: { gap: spacing.md },
  formActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  flex1: { flex: 1 },

  list: { gap: spacing.md },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarOff: { backgroundColor: colors.neutralTint },
  rowBody: { flex: 1, minWidth: 0, gap: 4 },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  name: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    flexShrink: 1,
    ...RTL_TEXT,
  },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  metaLtr: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    writingDirection: "ltr",
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  iconButton: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  iconButtonPressed: { backgroundColor: colors.neutralTint },
  iconButtonDisabled: { opacity: 0.3 },
});
