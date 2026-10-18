import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { collectionCredits } from "@matgary/api-client";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";

import { api } from "@/api/client";
import { collectionKeys, useCollectionAccounts } from "@/collections/queries";
import { DeviceRow } from "@/components/collections/setup/DeviceRow";
import * as store from "@/components/collections/setup/device-store";
import { collectionsErrorText } from "@/components/collections/setup/errors";
import { listStateOf, useCollectionDevices, useSetupRecord } from "@/components/collections/setup/useDevices";
import { useCollectionsAccess } from "@/components/collections/setup/useCollectionsAccess";
import { deviceHealth } from "@/components/collections/setup/wizard";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { t } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

const IOS_PLATFORMS = new Set(["ios_shortcut", "ios_app_intent"]);

/**
 * Linked phones (doc 15 spec 09 §4.7, M2): every live ingest device with the
 * server's health, "This phone" for the one in this phone's MMKV record, and
 * revoke. Revoking this phone clears its record (M3/M4: also the native
 * credential). A cold start from the `collection.source_silent` push lands
 * here; `fallback` keeps the back button working with no history.
 *
 * Gate: `canManage && ingest` (09 §4.2); the list itself is never
 * flag-gated on the server (D07-2), but the screen follows the hub's rule.
 */
export default function CollectionDevicesScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const access = useCollectionsAccess();
  const enabled = access.canManage && access.ingest;
  const devicesQ = useCollectionDevices(enabled);
  const accountsQ = useCollectionAccounts(enabled);
  const { record, refresh } = useSetupRecord(listStateOf(devicesQ));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (enabled) void devicesQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]),
  );

  const accountLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of accountsQ.accounts ?? []) m[a.id] = a.label;
    return m;
  }, [accountsQ.accounts]);

  const live = (devicesQ.data?.devices ?? []).filter((d) => !d.revokedAt);
  const thisId = record?.deviceId ?? null;
  const hasThisPhone = thisId != null && live.some((d) => d.id === thisId);

  const toWizard = () => router.push("/settings/collections/automation" as never);

  const doRevoke = async (d: collectionCredits.DeviceDTO) => {
    setBusyId(d.id);
    setNotice(null);
    try {
      await collectionCredits.revokeDevice(api, d.id);
      if (d.id === store.read()?.deviceId) {
        store.clear(); // M3: clearIngestCredential(); M4: clearCredentials()
        refresh();
      }
      setNotice({ tone: "ok", text: t("mobile.collections.setup.devices.revoked") });
      await qc.invalidateQueries({ queryKey: collectionKeys.devices() });
    } catch (e) {
      setNotice({ tone: "err", text: collectionsErrorText(e, t("mobile.collections.setup.devices.revokeFailed")) });
    } finally {
      setBusyId(null);
    }
  };

  const confirmRevoke = (d: collectionCredits.DeviceDTO) => {
    const body = [
      t("mobile.collections.setup.devices.revokeConfirmBody"),
      IOS_PLATFORMS.has(d.platform) ? t("mobile.collections.setup.devices.revokeIosHint") : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    Alert.alert(t("mobile.collections.setup.devices.revokeConfirmTitle", { label: d.label }), body, [
      { text: t("app.collectionsSettings.form.cancel"), style: "cancel" },
      { text: t("mobile.collections.setup.devices.revoke"), style: "destructive", onPress: () => void doRevoke(d) },
    ]);
  };

  const header = (
    <SettingsHeader
      parentLabel={t("app.collectionsSettings.title")}
      title={t("mobile.collections.setup.devices.title")}
      subtitle={t("mobile.collections.setup.devices.subtitle")}
      fallback="/settings/collections"
      accessories={
        enabled && devicesQ.isSuccess && !hasThisPhone ? (
          <Pressable
            testID="collection-devices-add-this-phone"
            accessibilityRole="button"
            onPress={toWizard}
            hitSlop={4}
            style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
          >
            <Plus size={16} color={colors.accent} weight="bold" />
            <Text style={styles.addText}>{t("mobile.collections.setup.devices.addThisPhone")}</Text>
          </Pressable>
        ) : undefined
      }
    />
  );

  if (!enabled) {
    return (
      <Screen header={header}>
        <Card>
          <Text style={styles.body} testID="collection-devices-gate">
            {!access.canManage ? t("app.collectionsSettings.noPermission") : t("mobile.collections.setup.unsupported.ingestOff")}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={() => void devicesQ.refetch()} refreshing={devicesQ.isRefetching}>
      {notice ? (
        <Pressable onPress={() => setNotice(null)} testID="collection-devices-notice">
          <Text style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>{notice.text}</Text>
        </Pressable>
      ) : null}
      {devicesQ.isPending ? (
        <ActivityIndicator color={colors.accent} />
      ) : devicesQ.isError && !devicesQ.data ? (
        <Card>
          <Text style={styles.body}>{t("mobile.settings.loadFailed")}</Text>
          <Button label={t("mobile.settings.retry")} variant="outline" onPress={() => void devicesQ.refetch()} />
        </Card>
      ) : live.length === 0 ? (
        <Card>
          <EmptyState compact title={t("mobile.collections.setup.devices.empty.title")} hint={t("mobile.collections.setup.devices.empty.hint")} />
          <View testID="collection-devices-empty-add" collapsable={false} style={styles.emptyAdd}>
            <Button label={t("mobile.collections.setup.devices.addThisPhone")} variant="outline" onPress={toWizard} />
          </View>
        </Card>
      ) : (
        <View style={styles.list}>
          {live.map((d) => {
            const isThisPhone = d.id === thisId;
            return (
              <DeviceRow
                key={d.id}
                device={d}
                health={deviceHealth(d, Date.now(), { thisDeviceId: thisId, os: Platform.OS })}
                isThisPhone={isThisPhone}
                accountLabels={accountLabels}
                onRevoke={() => confirmRevoke(d)}
                onSetupAgain={isThisPhone ? toWizard : undefined}
                busy={busyId === d.id}
              />
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  body: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 15, lineHeight: 24, color: colors.text },
  emptyAdd: { marginTop: spacing.md },
  notice: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, lineHeight: 22, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  noticeOk: { color: colors.successStrong, backgroundColor: colors.successLight },
  noticeErr: { color: colors.danger, backgroundColor: colors.dangerLight },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.md },
  addBtnPressed: { backgroundColor: colors.accentLight },
  addText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
});
