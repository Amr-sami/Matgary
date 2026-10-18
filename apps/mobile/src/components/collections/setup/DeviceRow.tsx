import { StyleSheet, Text, View } from "react-native";
import type { collectionCredits } from "@matgary/api-client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { t } from "@/i18n";
import { shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

import { healthTone, normalizeTs } from "./wizard";

const TONE_VARIANT = { danger: "outofstock", warning: "lowstock", neutral: "neutral", success: "success" } as const;

/** "19 Oct 2026 01:08" in the phone's local time; Postgres text forms are normalised first (Hermes). */
export function when(x: string | null | undefined): string {
  if (!x) return "—";
  const iso = normalizeTs(x);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${shortDate(iso)} ${hh}:${mm}`;
}

/**
 * One linked phone (doc 15 spec 09 §4.7): label (+ "This phone"), platform
 * and `mgi_<prefix>…`, the scoped accounts, who linked it and when, the last
 * message / transfer, the Android heartbeat + queue, and the health badge
 * from the server's `health` (with 09's one local override applied by the
 * caller). An unknown health value renders no badge.
 */
export function DeviceRow({
  device,
  health,
  isThisPhone,
  accountLabels,
  onRevoke,
  onSetupAgain,
  busy,
}: {
  device: collectionCredits.DeviceDTO;
  health: string;
  isThisPhone: boolean;
  /** id → label of the receiving accounts (for `devices.accountsList`). */
  accountLabels: Record<string, string>;
  onRevoke: () => void;
  onSetupAgain?: () => void;
  busy?: boolean;
}) {
  const tone = healthTone(health);
  const accounts =
    device.accountIds.length === 0
      ? t("mobile.collections.setup.devices.accountsAll")
      : t("mobile.collections.setup.devices.accountsList", {
          list: device.accountIds.map((id) => accountLabels[id] ?? "—").join("، "),
        });
  const hb = device.lastHeartbeat as { queued?: unknown } | null;
  const queued = typeof hb?.queued === "number" ? hb.queued : null;

  return (
    <View style={styles.row} testID={`collection-device-${device.id}`}>
      <View style={styles.head}>
        <Text style={styles.label} numberOfLines={1}>
          {device.label}
        </Text>
        {tone ? (
          <Badge
            label={t(`mobile.collections.setup.devices.health.${health}`)}
            variant={TONE_VARIANT[tone]}
          />
        ) : null}
      </View>
      {isThisPhone ? (
        <Text style={styles.thisPhone} testID="collection-device-this-phone">
          {t("mobile.collections.setup.devices.thisPhone")}
        </Text>
      ) : null}
      <Text style={styles.meta}>
        {t(`mobile.collections.setup.devices.platform.${device.platform}`)}
        {" · "}
        <Text style={styles.ltr}>{`⁦mgi_${device.tokenPrefix.replace(/^mgi_/, "")}…⁩`}</Text>
      </Text>
      <Text style={styles.meta}>{accounts}</Text>
      {device.createdBy?.name ? (
        <Text style={styles.meta}>
          {t("mobile.collections.setup.devices.linkedBy", { name: device.createdBy.name, date: shortDate(normalizeTs(device.createdAt)) })}
        </Text>
      ) : null}
      <Text style={styles.meta}>
        {device.lastMessageAt
          ? t("mobile.collections.setup.devices.lastMessage", { date: when(device.lastMessageAt) })
          : t("mobile.collections.setup.devices.never")}
      </Text>
      {device.lastCreditAt ? (
        <Text style={styles.meta}>{t("mobile.collections.setup.devices.lastCredit", { date: when(device.lastCreditAt) })}</Text>
      ) : null}
      {device.platform === "android_listener" ? (
        <>
          <Text style={styles.meta}>{t("mobile.collections.setup.devices.heartbeat", { date: when(device.lastSeenAt) })}</Text>
          {queued != null ? <Text style={styles.meta}>{t("mobile.collections.setup.devices.queued", { n: queued })}</Text> : null}
        </>
      ) : null}
      {health === "silent" ? <Text style={[styles.meta, styles.warn]}>{t("mobile.collections.setup.devices.health.silentHint")}</Text> : null}
      <View style={styles.actions}>
        {isThisPhone && onSetupAgain && health !== "ok" ? (
          <View testID={`collection-device-setup-again-${device.id}`} collapsable={false} style={styles.flex1}>
            <Button label={t("mobile.collections.setup.devices.setupAgain")} variant="outline" onPress={onSetupAgain} disabled={busy} />
          </View>
        ) : null}
        <View testID={`collection-device-revoke-${device.id}`} collapsable={false} style={styles.flex1}>
          <Button label={t("mobile.collections.setup.devices.revoke")} variant="ghost" onPress={onRevoke} loading={busy} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  label: { ...RTL_TEXT, flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  thisPhone: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.accent },
  meta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  ltr: { writingDirection: "ltr" },
  warn: { color: colors.danger },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  flex1: { flex: 1 },
});
