import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { collections } from "@matgary/api-client";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { WarningIcon as Warning } from "phosphor-react-native/src/icons/Warning";

import { api } from "@/api/client";
import { useCollectionAccounts, useCollectionSettings } from "@/collections/queries";
import { AccountRow } from "@/components/collections/setup/AccountRow";
import { collectionsScreenGate } from "@/components/collections/setup/access";
import { staleMinutesFrom } from "@/components/collections/setup/account-form";
import { collectionsErrorText } from "@/components/collections/setup/errors";
import { useSetupNotice, type SetupNotice } from "@/components/collections/setup/notice";
import { COLLECTION_ACCOUNTS_ROOT, collectionSettingsKey } from "@/components/collections/setup/queries";
import { useCollectionsAccess } from "@/components/collections/setup/useCollectionsAccess";
import { listStateOf, useCollectionDevices, useSetupRecord } from "@/components/collections/setup/useDevices";
import { entryHint } from "@/components/collections/setup/wizard";
import { Badge } from "@/components/ui/Badge";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { Sheet } from "@/components/ui/Sheet";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { t } from "@/i18n";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Settings = collections.CollectionSettings;
type SettingsPatch = collections.CollectionSettingsPatch;
type Rail = collections.CollectionRail;

/**
 * Digital collections — the settings hub (doc 15 spec 09 §4.3, M1).
 *
 * Top to bottom: header (active branch), the positioning intro, the branch
 * switches (`GET` → `PATCH /api/collections/settings`, one PATCH per change,
 * optimistic with rollback), the branch's receiving accounts, and the web
 * note. With `features.collectionsIngest` (M2, 09 step 15): the two L2 entry
 * rows ("Automatic confirmation" with this phone's hint, "Linked phones"
 * with the live count and a silent warning) and the reconcile of this
 * phone's link record against the devices list (09 §4.6.6: cleared only
 * when a fresh 200 list no longer has the device).
 *
 * Gates (09 §4.2): the screen needs `canManage` (owner or
 * manage_collection_accounts) and `features.collectionsAvailable`
 * (COLLECTIONS_ENABLED admits the tenant — NOT the branch switch, or the
 * owner could never turn it on). Offline: switches and "add" are disabled,
 * the cached list stays.
 */
export default function CollectionsSettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const refreshMe = useSession((s) => s.refreshMe);
  const online = useOffline((s) => s.online);
  const access = useCollectionsAccess();
  const branchId = me?.branch?.id ?? null;
  const enabled = collectionsScreenGate(access) === "ok";

  const settingsQ = useCollectionSettings(enabled);
  const accountsQ = useCollectionAccounts(enabled);
  const ingestRows = enabled && access.ingest;
  const devicesQ = useCollectionDevices(ingestRows);
  const { record } = useSetupRecord(listStateOf(devicesQ));
  const settings = settingsQ.data ?? null;
  const accounts = accountsQ.accounts;

  const [notice, setNotice] = useState<SetupNotice | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // null = show the server's value; a string = what the owner is typing.
  const [staleText, setStaleText] = useState<string | null>(null);
  const [staleInvalid, setStaleInvalid] = useState(false);

  // A sentence handed over by the account form it just popped (created /
  // saved / archived).
  useFocusEffect(
    useCallback(() => {
      const n = useSetupNotice.getState().take();
      if (n) setNotice(n);
      // Back from the wizard / devices screen: refresh the live list (and the reconcile).
      if (ingestRows) void devicesQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ingestRows]),
  );

  const settingsKey = collectionSettingsKey(branchId);
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => collections.updateSettings(api, patch),
    // Optimistic: the switch flips at once; a failure rolls it back with the
    // error text (the settings/notifications pattern).
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: settingsKey });
      const prev = qc.getQueryData<Settings>(settingsKey);
      if (prev) qc.setQueryData<Settings>(settingsKey, { ...prev, ...patch });
      return { prev };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData<Settings>(settingsKey, ctx.prev);
      setNotice({ tone: "err", text: collectionsErrorText(e, t("app.collectionsSettings.saveFailed")) });
    },
    onSuccess: async (res, patch) => {
      qc.setQueryData<Settings>(settingsKey, res);
      setNotice({ tone: "ok", text: t("app.collectionsSettings.saved") });
      if ("collectionsEnabled" in patch || "collectionsAutoConfirmEnabled" in patch) {
        // features.collections / collectionsAutoConfirm come from /me: the POS
        // chips and the nav entry follow without a relaunch (09 §6.2).
        try {
          await refreshMe();
        } catch {
          // The switch is saved; /me catches up on the next focus refresh.
        }
      }
      if ("collectionsEnabled" in patch) {
        // Every branch's picker + the settings entries (one snapshot root).
        await qc.invalidateQueries({ queryKey: COLLECTION_ACCOUNTS_ROOT });
      }
    },
  });

  const toggle = (patch: SettingsPatch) => {
    setNotice(null);
    save.mutate(patch);
  };

  const commitStale = () => {
    if (staleText == null || !settings) return;
    const n = staleMinutesFrom(staleText);
    if (n == null) {
      // Out of range or not a number: say so, send nothing (09 §6.3).
      setStaleInvalid(true);
      return;
    }
    setStaleInvalid(false);
    setStaleText(null);
    if (n !== settings.collectionsStaleAfterMinutes) toggle({ collectionsStaleAfterMinutes: n });
  };

  const refresh = () => {
    void settingsQ.refetch();
    void accountsQ.query.refetch();
    if (ingestRows) void devicesQ.refetch();
  };

  const openForm = (rail: Rail) => {
    setAddOpen(false);
    router.push(`/settings/collections/account/new?rail=${rail}` as never);
  };

  const header = (
    <SettingsHeader
      parentLabel={t("app.settingsPage.title")}
      title={t("app.collectionsSettings.title")}
      subtitle={t("app.collectionsSettings.branchLine", { branch: me?.branch?.name ?? "—" })}
      fallback="/settings"
    />
  );

  const gate = collectionsScreenGate(access);
  if (gate !== "ok") {
    return (
      <Screen header={header}>
        <Card>
          <Text style={styles.hint} testID="collections-settings-gate">
            {gate === "noPermission"
              ? t("app.collectionsSettings.noPermission")
              : t("app.collectionsSettings.unavailable")}
          </Text>
        </Card>
      </Screen>
    );
  }

  const locked = !online || save.isPending;
  const staleValue = staleText ?? (settings ? String(settings.collectionsStaleAfterMinutes) : "");
  const hasAccounts = (accounts?.length ?? 0) > 0;

  return (
    <Screen
      header={header}
      onRefresh={refresh}
      refreshing={settingsQ.isRefetching || accountsQ.query.isRefetching || devicesQ.isRefetching}
    >
      {notice ? (
        <Pressable onPress={() => setNotice(null)} testID="collections-settings-notice">
          <Text style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>{notice.text}</Text>
        </Pressable>
      ) : null}

      {!online ? (
        <Text style={[styles.notice, styles.noticeWarn]} testID="collections-settings-offline">
          {t("mobile.common.offline")}
        </Text>
      ) : null}

      <Card>
        <Text style={styles.intro}>{t("app.collectionsSettings.intro")}</Text>
      </Card>

      {/* Branch switches */}
      {settingsQ.isLoading && !settings ? (
        <ActivityIndicator color={colors.accent} />
      ) : !settings ? (
        <Card>
          <Text style={styles.hint}>{t("mobile.settings.loadFailed")}</Text>
          <Button
            label={t("mobile.settings.retry")}
            variant="outline"
            onPress={() => void settingsQ.refetch()}
            loading={settingsQ.isRefetching}
            style={styles.retry}
          />
        </Card>
      ) : (
        <Card>
          <ToggleRow
            testID="collections-settings-enabled"
            label={t("app.collectionsSettings.switches.enabled.label")}
            hint={t("app.collectionsSettings.switches.enabled.hint")}
            value={settings.collectionsEnabled}
            disabled={locked}
            onValueChange={(v) => toggle({ collectionsEnabled: v })}
          />
          {settings.collectionsEnabled ? (
            <>
              <View style={styles.divider} />
              <ToggleRow
                testID="collections-settings-require_account"
                label={t("app.collectionsSettings.switches.requireAccount.label")}
                hint={t("app.collectionsSettings.switches.requireAccount.hint")}
                value={settings.collectionsRequireAccount}
                disabled={locked}
                onValueChange={(v) => toggle({ collectionsRequireAccount: v })}
              />
              <View style={styles.divider} />
              <Field
                testID="collections-settings-stale_after_minutes"
                label={t("app.collectionsSettings.switches.staleAfter.label")}
                value={staleValue}
                onChangeText={(v) => {
                  setStaleText(v);
                  setStaleInvalid(false);
                }}
                onEndEditing={commitStale}
                keyboardType="number-pad"
                maxLength={4}
                ltr
                editable={!locked}
              />
              <Text style={[styles.fieldHint, staleInvalid && styles.fieldError]} testID={staleInvalid ? "collections-settings-stale_after_minutes-error" : undefined}>
                {staleInvalid
                  ? t("app.collectionsSettings.switches.staleAfter.invalid")
                  : t("app.collectionsSettings.switches.staleAfter.hint")}
              </Text>
            </>
          ) : null}
          {access.ingest ? (
            <>
              <View style={styles.divider} />
              <ToggleRow
                testID="collections-settings-auto_confirm_enabled"
                label={t("app.collectionsSettings.switches.autoConfirm.label")}
                hint={t("app.collectionsSettings.switches.autoConfirm.hint")}
                value={settings.collectionsAutoConfirmEnabled}
                disabled={locked}
                onValueChange={(v) => toggle({ collectionsAutoConfirmEnabled: v })}
              />
              <View style={styles.divider} />
              <ToggleRow
                testID="collections-settings-store_payer_names"
                label={t("app.collectionsSettings.switches.payerNames.label")}
                hint={t("app.collectionsSettings.switches.payerNames.hint")}
                value={settings.collectionsStorePayerNames}
                disabled={locked}
                onValueChange={(v) => toggle({ collectionsStorePayerNames: v })}
              />
            </>
          ) : null}
        </Card>
      )}

      {/* Receiving accounts */}
      <Card>
        <View style={styles.cardHead}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            {t("app.collectionsSettings.accounts.heading")}
          </Text>
          <Pressable
            testID="collection-accounts-add"
            accessibilityRole="button"
            accessibilityState={{ disabled: !online }}
            disabled={!online}
            onPress={() => setAddOpen(true)}
            hitSlop={4}
            style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed, !online && styles.addBtnDisabled]}
          >
            <Plus size={16} color={online ? colors.accent : colors.textSecondary} weight="bold" />
            <Text style={[styles.addText, !online && styles.addTextDisabled]}>
              {t("app.collectionsSettings.accounts.add")}
            </Text>
          </Pressable>
        </View>

        {settings?.collectionsEnabled && accounts && accounts.length === 0 ? (
          <View style={styles.warnRow} testID="collection-accounts-none-while-enabled">
            <Warning size={16} color={colors.warningStrong} />
            <Text style={styles.warnText}>{t("app.collectionsSettings.accounts.noneWhileEnabled")}</Text>
          </View>
        ) : null}

        {accountsQ.isLoading && !accounts ? (
          <ActivityIndicator color={colors.accent} />
        ) : !accounts ? (
          <View style={styles.gap}>
            <Text style={styles.hint}>{t("mobile.settings.loadFailed")}</Text>
            <Button
              label={t("mobile.settings.retry")}
              variant="outline"
              onPress={() => void accountsQ.query.refetch()}
              loading={accountsQ.query.isRefetching}
            />
          </View>
        ) : !hasAccounts ? (
          <View style={styles.gap}>
            <EmptyState
              compact
              title={t("app.collectionsSettings.accounts.empty.title")}
              hint={t("app.collectionsSettings.accounts.empty.hint")}
            />
            {/* Not while the add sheet is up: the sheet's rows carry the same ids. */}
            {addOpen ? null : (
              <View style={styles.emptyActions}>
                <View testID="collection-accounts-add-instapay" collapsable={false} style={styles.flex1}>
                  <Button
                    label={t("app.collectionsSettings.accounts.addInstapay")}
                    variant="outline"
                    disabled={!online}
                    onPress={() => openForm("instapay")}
                  />
                </View>
                <View testID="collection-accounts-add-wallet" collapsable={false} style={styles.flex1}>
                  <Button
                    label={t("app.collectionsSettings.accounts.addWallet")}
                    variant="outline"
                    disabled={!online}
                    onPress={() => openForm("wallet")}
                  />
                </View>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.list}>
            {accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                showAutoConfirm={access.ingest}
                onPress={() => router.push(`/settings/collections/account/${a.id}` as never)}
              />
            ))}
          </View>
        )}

        {(me?.branches.length ?? 0) > 1 ? (
          <Text style={[styles.fieldHint, styles.footnote]}>{t("app.collectionsSettings.accounts.otherBranchesNote")}</Text>
        ) : null}
      </Card>

      {/* L2 entries (09 §4.3 item 5, M2) */}
      {ingestRows ? (
        <Card>
          <EntryRow
            testID="collections-settings-automation"
            title={t("mobile.collections.setup.entry.title")}
            hint={t(`mobile.collections.setup.entry.${entryHint(record)}`)}
            onPress={() => router.push("/settings/collections/automation" as never)}
          />
          <View style={styles.divider} />
          <EntryRow
            testID="collections-settings-devices"
            title={t("mobile.collections.setup.devicesEntry.title")}
            hint={t("mobile.collections.setup.devicesEntry.hint")}
            count={devicesQ.data ? devicesQ.data.devices.filter((d) => !d.revokedAt).length : null}
            onPress={() => router.push("/settings/collections/devices" as never)}
          />
          {devicesQ.data?.devices.some((d) => !d.revokedAt && d.health === "silent") ? (
            <View style={styles.warnRow} testID="collections-settings-devices-silent">
              <Warning size={16} color={colors.danger} />
              <Text style={[styles.warnText, styles.dangerText]}>{t("mobile.collections.setup.devicesEntry.silentWarning")}</Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      <Text style={styles.webNote}>{t("app.collectionsSettings.webNote")}</Text>

      <Sheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        title={t("app.collectionsSettings.accounts.addChooseTitle")}
        testID="collection-accounts-add-sheet"
      >
        <View style={styles.list}>
          <AddRow
            label={t("app.collectionsSettings.accounts.addInstapay")}
            testID="collection-accounts-add-instapay"
            onPress={() => openForm("instapay")}
          />
          <AddRow
            label={t("app.collectionsSettings.accounts.addWallet")}
            testID="collection-accounts-add-wallet"
            onPress={() => openForm("wallet")}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

/** An L2 entry row on the hub: title, hint, optional bare-number badge, chevron. */
function EntryRow({
  title,
  hint,
  count,
  onPress,
  testID,
}: {
  title: string;
  hint: string;
  count?: number | null;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.entryRow, pressed && styles.entryRowPressed]}
    >
      <View style={styles.addRowBody}>
        <Text style={styles.addRowLabel}>{title}</Text>
        <Text style={styles.fieldHint}>{hint}</Text>
      </View>
      {count != null ? <Badge label={String(count)} variant="neutral" /> : null}
      <ChevronForward size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

/** One choice in the "What kind of account?" sheet. */
function AddRow({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.addRow, pressed && styles.addRowPressed]}
    >
      <View style={styles.addRowBody}>
        <Text style={styles.addRowLabel}>{label}</Text>
      </View>
      <ChevronForward size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  addRowPressed: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  entryRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: MIN_TOUCH + spacing.lg, borderRadius: radius.md },
  entryRowPressed: { backgroundColor: colors.accentLight },
  addRowBody: { flex: 1, minWidth: 0, gap: 2 },
  addRowLabel: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
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
  noticeWarn: { backgroundColor: colors.warningTint, color: colors.warningStrong },
  intro: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.text },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  retry: { marginTop: spacing.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.sm },
  fieldHint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: spacing.xs },
  fieldError: { color: colors.danger, fontFamily: fonts.medium },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  cardTitle: { ...RTL_TEXT, flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: colors.text },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  addBtnPressed: { backgroundColor: colors.accentLight },
  addBtnDisabled: { borderColor: colors.border },
  addText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
  addTextDisabled: { color: colors.textSecondary },
  warnRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningLight,
    marginBottom: spacing.md,
  },
  warnText: { ...RTL_TEXT, flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.warningStrong },
  dangerText: { color: colors.danger },
  gap: { gap: spacing.md },
  list: { gap: spacing.sm },
  emptyActions: { flexDirection: "row", gap: spacing.sm },
  flex1: { flex: 1 },
  footnote: { marginTop: spacing.md },
  webNote: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, paddingHorizontal: spacing.xs },
});
