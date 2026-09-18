import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { notifications } from "@matgary/api-client";

import { api } from "@/api/client";
import { forgetRegistration } from "@/effects/PushRegistrar";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { ChevronBack } from "@/components/ui/Chevron";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { usePush, type PushStatus } from "@/stores/push";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__settings-notifications.png.
 *
 * DELIBERATE DEVIATION, and the only one on this screen: the web renders a
 * four-column grid (الحدث · داخل التطبيق · البريد · التسليم). At 360dp that
 * grid gives the event title ~90px, which breaks "تنبيه مخزون منخفض" one word
 * per line — the exact defect the polish pass exists to kill. The same four
 * fields become labelled rows inside one card per event; every string,
 * every default and every PUT body is unchanged.
 *
 * ADDITION over the web (doc 06 §8.3): a "Push" switch per event — the phone
 * column the web page has no use for. The server only pushes when in-app is
 * on AND delivery is instant (dispatch.ts skips digest-mode events), so the
 * switch shows the EFFECTIVE state: it dims with in-app off, the way delivery
 * dims with email off, and dims again — with a hint saying why — while the
 * event is on the daily digest.
 */
type EventType = notifications.NotificationEventType;
type Pref = notifications.EventPreference;
type Prefs = notifications.NotificationPreferences;

const PREFS_KEY = ["notification-preferences"] as const;

/** The GET payload with one event's row replaced by `patch`. */
function withPatch(cur: Prefs, patch: Pref): Prefs {
  return {
    ...cur,
    preferences: cur.preferences.map((p) =>
      p.eventType === patch.eventType ? { ...p, ...patch } : p,
    ),
  };
}

/** apps/web/dictionaries/ar.json → app.notificationSettings.events */
const EVENTS = (): Record<EventType, { title: string; hint: string }> => ({
  "sale.created": {
    title: t("app.notificationSettings.events.sale.created.title"),
    hint: t("app.notificationSettings.events.sale.created.hint"),
  },
  "purchase.received": {
    title: t("app.notificationSettings.events.purchase.received.title"),
    hint: t("app.notificationSettings.events.purchase.received.hint"),
  },
  "inventory.low_stock": {
    title: t("app.notificationSettings.events.inventory.low_stock.title"),
    hint: t("app.notificationSettings.events.inventory.low_stock.hint"),
  },
  "payment.deferred_settled": {
    title: t("app.notificationSettings.events.payment.deferred_settled.title"),
    hint: t("app.notificationSettings.events.payment.deferred_settled.hint"),
  },
  "leave.requested": {
    title: t("app.notificationSettings.events.leave.requested.title"),
    hint: t("app.notificationSettings.events.leave.requested.hint"),
  },
});

const DELIVERY = () => ([
  { key: "instant" as const, label: t("app.notificationSettings.delivery.instant") },
  { key: "digest" as const, label: t("app.notificationSettings.delivery.digest") },
]);

export default function NotificationSettingsScreen() {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const qc = useQueryClient();
  const q = useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => notifications.getPreferences(api),
  });

  const save = useMutation({
    mutationFn: (patch: Pref) =>
      notifications.setPreference(api, {
        eventType: patch.eventType,
        inApp: patch.inApp,
        push: patch.push,
        email: patch.email,
        digestMode: patch.digestMode,
      }),
    // Optimistic: the switch the user just flipped shows its new value during
    // the PUT instead of snapping back to the stale row until the GET lands.
    onMutate: (patch) => {
      qc.setQueryData<Prefs>(PREFS_KEY, (cur) => (cur ? withPatch(cur, patch) : cur));
    },
    onSuccess: (res, patch) => {
      setNotice({ tone: "ok", text: t("app.notificationSettings.savedToast") });
      // `isDefault` comes from the server — it DELETES the row when a patch
      // happens to match the code default for this role.
      qc.setQueryData<Prefs>(PREFS_KEY, (cur) =>
        cur ? withPatch(cur, { ...patch, isDefault: res.isDefault }) : cur,
      );
      // RETURNED, not `void`ed: `isPending` stays true until the re-read
      // lands, so the card stays locked and a second toggle cannot spread a
      // stale row into its PUT body and revert this one on the server.
      return q.refetch();
    },
    onError: () => {
      setNotice({ tone: "err", text: t("app.notificationSettings.errorToast") });
      // Drops the optimistic row; the server is the truth. Awaited for the
      // same lock-until-fresh reason as onSuccess.
      return q.refetch();
    },
  });

  const rows = q.data?.preferences ?? [];

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
        >
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("app.shell.notifications.title")}</Text>
        <Text style={styles.subtitle}>
          {t("app.notificationSettings.intro")}
        </Text>
        {q.data ? (
          <Text style={styles.role}>
            {q.data.role === "owner" ? t("app.notificationSettings.role.owner") : t("app.notificationSettings.role.staff")}
          </Text>
        ) : null}
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

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : q.isError && !q.data ? (
        // A failed FIRST load used to render nothing at all between the header
        // and the This-device card — no message, no retry. A refetch that fails
        // after one good load keeps the rows (`q.data` is still there).
        <View style={styles.errorBox}>
          <Text style={styles.err}>{t("mobile.push.prefsLoadFailed")}</Text>
          <Button
            label={t("app.common.retry")}
            variant="ghost"
            loading={q.isRefetching}
            onPress={() => void q.refetch()}
          />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState title={t("mobile.push.prefsEmpty")} />
      ) : (
        rows.map((p) => {
          const meta = EVENTS()[p.eventType];
          const saving = save.isPending && save.variables?.eventType === p.eventType;
          // Mirror of dispatch.ts: a push goes out only when in-app is on AND
          // the event is not on the daily digest. The switch shows that
          // effective state — a stored `push: true` the server will never
          // act on must not render as ON.
          const pushBlocked = !p.inApp || p.digestMode === "digest";
          // In-app off wins the hint (it blocks first); otherwise say digest.
          const pushHint =
            p.inApp && pushBlocked
              ? t("mobile.push.perEventDigestHint")
              : t("mobile.push.perEventHint");
          return (
            <Card key={p.eventType}>
              <View style={styles.eventHead}>
                <Text numberOfLines={1} style={styles.eventTitle}>
                  {meta?.title ?? p.eventType}
                </Text>
                {p.isDefault ? <Badge label={t("app.notificationSettings.defaultBadge")} /> : null}
              </View>
              <Text style={styles.eventHint}>{meta?.hint}</Text>

              <View style={styles.divider} />

              <View style={styles.toggleRow}>
                <Text numberOfLines={1} style={styles.toggleLabel}>
                  {t("app.notificationSettings.headers.inApp")}
                </Text>
                <Switch
                  value={p.inApp}
                  disabled={saving}
                  onValueChange={(v) => save.mutate({ ...p, inApp: v })}
                  trackColor={{ true: colors.accent, false: colors.border }}
                />
              </View>

              <View
                pointerEvents={!pushBlocked && !saving ? "auto" : "none"}
                style={[styles.toggleRow, pushBlocked ? styles.disabled : undefined]}
              >
                <View style={styles.toggleText}>
                  <Text numberOfLines={1} style={styles.toggleLabel}>
                    {t("mobile.push.perEvent")}
                  </Text>
                  <Text numberOfLines={2} style={styles.toggleHint}>
                    {pushHint}
                  </Text>
                </View>
                <Switch
                  value={!pushBlocked && p.push}
                  disabled={saving || pushBlocked}
                  onValueChange={(v) => save.mutate({ ...p, push: v })}
                  trackColor={{ true: colors.accent, false: colors.border }}
                />
              </View>

              <View style={styles.toggleRow}>
                <Text numberOfLines={1} style={styles.toggleLabel}>
                  {t("app.notificationSettings.headers.email")}
                </Text>
                <Switch
                  value={p.email}
                  disabled={saving}
                  onValueChange={(v) => save.mutate({ ...p, email: v })}
                  trackColor={{ true: colors.accent, false: colors.border }}
                />
              </View>

              <Text style={styles.deliveryLabel}>{t("app.notificationSettings.headers.delivery")}</Text>
              {/* The web disables the delivery select while email is off —
                  reproduced with pointerEvents rather than a new prop on
                  Segmented, which has no disabled state to re-style. */}
              <View
                pointerEvents={p.email && !saving ? "auto" : "none"}
                style={!p.email ? styles.disabled : undefined}
              >
                <Segmented
                  items={DELIVERY()}
                  value={p.digestMode}
                  onChange={(v) => save.mutate({ ...p, digestMode: v })}
                />
              </View>
            </Card>
          );
        })
      )}

      <ThisDeviceCard onNotice={setNotice} />
    </Screen>
  );
}

/** Badge variant + copy for each push status (src/stores/push.ts). */
const PUSH_STATUS = (): Record<
  PushStatus,
  { label: string; hint: string | null; variant: "success" | "lowstock" | "outofstock" | "neutral" }
> => ({
  idle: { label: t("mobile.push.status.idle"), hint: null, variant: "neutral" },
  granted: { label: t("mobile.push.status.granted"), hint: null, variant: "success" },
  denied: { label: t("mobile.push.status.denied"), hint: t("mobile.push.deniedHint"), variant: "outofstock" },
  unsupported: {
    label: t("mobile.push.status.unsupported"),
    hint: t("mobile.push.unsupportedHint"),
    variant: "neutral",
  },
  noProjectId: {
    label: t("mobile.push.status.noProjectId"),
    hint: t("mobile.push.noProjectIdDetail"),
    variant: "lowstock",
  },
  error: { label: t("mobile.push.status.error"), hint: null, variant: "outofstock" },
});

/**
 * "This device" — the one card the web cannot have. Reads what
 * <PushRegistrar/> recorded in the push store and offers the two fixes a user
 * can actually apply: the OS settings page when permission was denied, and a
 * server-side test push once a token is registered.
 */
function ThisDeviceCard({
  onNotice,
}: {
  onNotice: (n: { tone: "ok" | "err"; text: string } | null) => void;
}) {
  const push = usePush();
  const meta = PUSH_STATUS()[push.status];

  // HTTP 200 is not delivery: the route answers 200 with `sent: 0` when every
  // Expo ticket failed, and `disabled > 0` means it pruned a token — ours, if
  // our ticket errored — so MMKV must forget it or postToken() short-circuits
  // on "already registered" forever and this device silently never re-POSTs.
  const test = useMutation({
    mutationFn: () => notifications.sendTestPush(api),
    onSuccess: (r) => {
      const mine = r.tickets.find((tk) => tk.to === push.token) ?? r.tickets[0];
      const pruned = r.disabled > 0 && (!mine || mine.status === "error");
      if (pruned) {
        forgetRegistration();
        push.retry(); // re-mint + re-POST now, not on the next foreground
      }
      if (r.sent > 0) {
        onNotice({ tone: "ok", text: t("mobile.push.testSent") });
        return;
      }
      const error = mine?.error ?? r.tickets.find((tk) => tk.error)?.error ?? r.status;
      onNotice({
        tone: "err",
        text: pruned
          ? `${t("mobile.push.testFailedDetail", { error })} ${t("mobile.push.testReregistering")}`
          : t("mobile.push.testFailedDetail", { error }),
      });
    },
    onError: () => onNotice({ tone: "err", text: t("mobile.push.testFailed") }),
  });

  const canTest = push.status === "granted" && push.registered;
  const canRetry =
    push.status === "error" || (push.status === "granted" && !push.registered);

  return (
    <Card>
      <View style={styles.eventHead}>
        <Text numberOfLines={1} style={styles.eventTitle}>
          {t("mobile.push.thisDevice")}
        </Text>
        <Badge label={meta.label} variant={meta.variant} />
      </View>
      <Text style={styles.eventHint}>{t("mobile.push.intro")}</Text>

      <View style={styles.divider} />

      <View style={styles.toggleRow}>
        <Text numberOfLines={1} style={styles.toggleLabel}>
          {t("mobile.push.status.label")}
        </Text>
        <Text numberOfLines={1} style={styles.deviceValue}>
          {meta.label}
        </Text>
      </View>
      {push.status === "granted" ? (
        <View style={styles.toggleRow}>
          <Text numberOfLines={1} style={styles.toggleLabel}>
            {t("mobile.push.registration")}
          </Text>
          <Text numberOfLines={1} style={styles.deviceValue}>
            {push.registered ? t("mobile.push.registered") : t("mobile.push.notRegistered")}
          </Text>
        </View>
      ) : null}
      {meta.hint ? <Text style={styles.eventHint}>{meta.hint}</Text> : null}
      {push.error && (push.status === "error" || !push.registered) ? (
        <Text style={[styles.eventHint, styles.deviceError]} numberOfLines={3}>
          {push.error}
        </Text>
      ) : null}

      <View style={styles.deviceActions}>
        {push.status === "denied" ? (
          <Button
            label={t("mobile.push.openSettings")}
            variant="outline"
            onPress={() => {
              Linking.openSettings().catch(() => {
                onNotice({ tone: "err", text: t("mobile.push.openSettingsFailed") });
              });
            }}
          />
        ) : null}
        {canRetry ? (
          <Button
            label={t("mobile.push.retry")}
            variant="outline"
            onPress={() => push.retry()}
          />
        ) : null}
        {canTest ? (
          <Button
            label={t("mobile.push.sendTest")}
            loading={test.isPending}
            onPress={() => test.mutate()}
          />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  role: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: spacing.sm,
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

  eventHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  eventTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    flexShrink: 1,
    ...RTL_TEXT,
  },
  eventHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
    ...RTL_TEXT,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
  },
  toggleLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    flexShrink: 1,
    ...RTL_TEXT,
  },
  toggleText: { flex: 1, flexShrink: 1, gap: 2 },
  toggleHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  deliveryLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  disabled: { opacity: 0.5 },

  errorBox: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.lg },
  err: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.danger,
    textAlign: "center",
  },

  deviceValue: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    flexShrink: 1,
  },
  deviceError: { color: colors.danger },
  deviceActions: { gap: spacing.sm, marginTop: spacing.md },
});
