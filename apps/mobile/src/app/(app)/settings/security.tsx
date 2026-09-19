import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AndroidLogoIcon as AndroidLogo } from "phosphor-react-native/src/icons/AndroidLogo";
import { AppleLogoIcon as AppleLogo } from "phosphor-react-native/src/icons/AppleLogo";
import { DesktopIcon as Desktop } from "phosphor-react-native/src/icons/Desktop";
import { DeviceMobileIcon as DeviceMobile } from "phosphor-react-native/src/icons/DeviceMobile";
import { auth, type DeviceSummary } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, MIN_TOUCH, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__account-security.png (/account/security on the web), plus the
 * one native addition doc 02 §1.1 row 24 calls for: the per-device session
 * list (doc 06 §7.6). Every device that holds a refresh token is a row in
 * `auth_devices`; GET /api/v1/auth/devices lists the live ones and marks the
 * caller's own, DELETE ?id= revokes one. "Sign out everywhere" stays as the
 * blunt instrument.
 *
 * Intentional deviation for staff: the web page renders ONLY the staffNotice
 * for non-owners, while this screen also shows the devices card AND "Sign out
 * everywhere". Both are the caller's own sessions and nothing else —
 * /api/v1/auth/devices scopes by user_id and /api/account/sessions/revoke-all
 * bumps only the caller's own token_version — and a cashier who lost a phone
 * needs both just as much as an owner does.
 *
 * One capability genuinely does not exist on this client and is NOT faked:
 *
 *  - The QR code. The web lazy-imports `qrcode` to draw the otpauth:// URI;
 *    there is no such dependency here and adding one is out of scope. On a
 *    phone the QR would be pointless anyway — the authenticator app is on the
 *    SAME device — so the enrolment step offers the otpauth:// deep link
 *    (which opens Google/Microsoft Authenticator directly) plus the manual
 *    secret the web hides behind a <details>.
 *  - "تنزيل البيانات" POSTs and streams a JSON file to disk. expo-file-system
 *    and expo-sharing are not installed, so the button is rendered DISABLED
 *    with a note rather than wired to something that would silently do
 *    nothing. See the report.
 */
type Status = "loading" | "off" | "enrolling" | "on" | "showingCodes";

interface EnrollmentPreview {
  secret: string;
  otpauthUri: string;
}

const DEVICES_KEY = ["auth-devices"] as const;

/** One revoke plus two follow-ups against a successor that rotated in under us. */
const REVOKE_ATTEMPTS = 3;

/**
 * Rotation carries device_name, platform and created_at forward onto the
 * successor row (refresh/route.ts), so the three together identify one
 * install's lineage across ids. install_id would be the exact key but the
 * list route does not expose it.
 */
function sameLineage(a: DeviceSummary, b: DeviceSummary): boolean {
  return a.createdAt === b.createdAt && a.deviceName === b.deviceName && a.platform === b.platform;
}

/**
 * t() is plain interpolation with no plural rules, and "{n} devices" reads
 * "1 devices" in the common single-device case (Arabic needs dual and 3-10
 * forms on top). Branch here instead.
 */
function deviceCountLabel(n: number): string {
  if (n === 1) return t("mobile.security.devices.count_one");
  if (n === 2) return t("mobile.security.devices.count_two");
  if (n >= 3 && n <= 10) return t("mobile.security.devices.count_few", { n });
  return t("mobile.security.devices.count_other", { n });
}

const ERRORS = (): Record<string, string> => ({
  INVALID_TOTP: t("app.accountSecurity.errors.badCode"),
  BAD_PASSWORD: t("app.accountSecurity.errors.badPassword"),
  NOT_ENROLLED: t("app.accountSecurity.errors.notEnrolled"),
  SLUG_MISMATCH: t("app.accountSecurity.delete.errors.slugMismatch"),
  Forbidden: t("app.accountSecurity.delete.errors.forbidden"),
});

function errorText(e: unknown, fallback: string): string {
  const code = (e as { code?: string | null })?.code ?? "";
  return ERRORS()[code] ?? fallback;
}

/**
 * The devices route serialises Postgres timestamptz through drizzle's raw
 * `db.execute`, so the wire form is "2026-09-18 02:34:20.571236+00" — a space
 * instead of T, six fractional digits, and an hour-only offset. V8 tolerates
 * all three; Hermes's Date parser does not. Rewrite it to strict ISO before
 * handing it to shortDate(), which does `new Date(iso)`.
 */
function pgToIso(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return ts
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})$/, "$1:00");
}

function platformLabel(platform: string | null): string {
  switch (platform) {
    case "ios":
      return t("mobile.security.devices.platformIos");
    case "android":
      return t("mobile.security.devices.platformAndroid");
    case "web":
      return t("mobile.security.devices.platformWeb");
    default:
      return "";
  }
}

function PlatformIcon({ platform }: { platform: string | null }) {
  const props = { size: 22, color: colors.textSecondary } as const;
  switch (platform) {
    case "ios":
      return <AppleLogo {...props} />;
    case "android":
      return <AndroidLogo {...props} />;
    case "web":
      return <Desktop {...props} />;
    default:
      return <DeviceMobile {...props} />;
  }
}

function deviceTitle(d: DeviceSummary): string {
  return d.deviceName?.trim() || platformLabel(d.platform) || t("mobile.security.devices.unknownDevice");
}

function DeviceRow({
  device,
  onRevoke,
  revoking,
}: {
  device: DeviceSummary;
  onRevoke: (d: DeviceSummary) => void;
  revoking: boolean;
}) {
  const platform = platformLabel(device.platform);
  const meta = [platform, device.appVersion ? `v${device.appVersion}` : ""]
    .filter(Boolean)
    .join(" · ");
  // lastUsedAt is bumped on every refresh (≤15 min); a device that has never
  // refreshed yet only has its sign-in time, which is still a "last seen".
  const seen = device.lastUsedAt
    ? t("mobile.security.devices.lastSeen", { date: shortDate(pgToIso(device.lastUsedAt)) })
    : t("mobile.security.devices.signedIn", { date: shortDate(pgToIso(device.createdAt)) });

  return (
    <View style={styles.deviceRow}>
      <View style={styles.deviceIcon}>
        <PlatformIcon platform={device.platform} />
      </View>
      <View style={styles.deviceBody}>
        <View style={styles.deviceTitleRow}>
          <Text numberOfLines={1} style={styles.deviceName}>
            {deviceTitle(device)}
          </Text>
          {device.current ? (
            <Badge label={t("mobile.security.devices.thisDevice")} variant="accent" />
          ) : null}
        </View>
        {meta && meta !== deviceTitle(device) ? (
          <Text numberOfLines={1} style={styles.deviceMeta}>
            {meta}
          </Text>
        ) : null}
        <Text numberOfLines={1} style={styles.deviceMeta}>
          {seen}
        </Text>
      </View>
      {device.current ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.security.devices.revoke")}
          disabled={revoking}
          onPress={() => onRevoke(device)}
          hitSlop={8}
          style={({ pressed }) => [styles.revoke, (pressed || revoking) && styles.revokePressed]}
        >
          {revoking ? (
            <ActivityIndicator size="small" color={colors.danger} />
          ) : (
            <Text style={styles.revokeLabel}>{t("mobile.security.devices.revoke")}</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

export default function SecurityScreen() {
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const signOut = useSession((s) => s.signOut);
  const isOwner = me?.isOwner ?? false;

  // `null` is "the server has not answered yet". Deriving it from the query
  // instead would be wrong: every button below MOVES this machine, and a
  // cached 2fa-status must not drag it back.
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<EnrollmentPreview | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["2fa-status"],
    queryFn: () =>
      api
        .request<{ enabled: boolean }>("/api/account/2fa-status")
        .catch(() => ({ enabled: false })),
    enabled: isOwner,
  });

  // Seeds ONCE. A cached answer (react-query holds it for 30s) still lands
  // here on a re-entry, which a side effect inside queryFn would have missed.
  useEffect(() => {
    if (status === null && statusQuery.data) {
      setStatus(statusQuery.data.enabled ? "on" : "off");
    }
  }, [status, statusQuery.data]);

  // ---- Signed-in devices (doc 06 §7.6) -----------------------------------
  // Keyed on the user, not the tenant: the route scopes by user_id, and a
  // branch switch must not serve a stale list from another principal.
  const devicesQuery = useQuery({
    queryKey: [...DEVICES_KEY, me?.user?.id ?? null],
    queryFn: () => auth.listDevices(api),
    enabled: !!me,
  });

  // A device row's id is NOT stable: every refresh the other device performs
  // (<=15 min, and whenever it comes to the foreground) revokes its row with
  // reason 'rotated' and inserts a successor under a new id. The list here is
  // served from cache for up to 30s, so the id the user taps can already be
  // dead — and DELETE ?id=<dead> answers 200 {ok:true} (COALESCE on an
  // already-revoked row) while the live successor keeps working. Revoking the
  // tapped id and trusting the 200 was therefore a silent no-op in a real
  // window. Instead: re-list right before firing, aim at the LIVE row of the
  // same lineage, then re-list and confirm it is gone — following a successor
  // that appeared mid-flight — and only report success once the list agrees.
  const revokeDevice = useMutation({
    mutationFn: async (picked: DeviceSummary): Promise<DeviceSummary[]> => {
      let list = await auth.listDevices(api);
      for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
        const live =
          list.find((x) => x.id === picked.id) ??
          list.find((x) => !x.current && sameLineage(x, picked));
        if (!live) return list;
        await auth.revokeDevice(api, live.id);
        list = await auth.listDevices(api);
      }
      throw new Error("DEVICE_STILL_LIVE");
    },
    onSuccess: (list) => {
      setError(null);
      setNotice(t("mobile.security.devices.revoked"));
      // The list we just confirmed against IS the truth; no optimistic filter
      // and no extra invalidate round-trip needed.
      qc.setQueryData<DeviceSummary[]>([...DEVICES_KEY, me?.user?.id ?? null], list);
    },
    onError: () => {
      setNotice(null);
      setError(t("mobile.security.devices.revokeFailed"));
      void qc.invalidateQueries({ queryKey: DEVICES_KEY });
    },
  });

  const confirmRevoke = (d: DeviceSummary) => {
    Alert.alert(
      t("mobile.security.devices.revokeConfirmTitle"),
      t("mobile.security.devices.revokeConfirm", { name: deviceTitle(d) }),
      [
        { text: t("app.common.cancel"), style: "cancel" },
        {
          text: t("mobile.security.devices.revoke"),
          style: "destructive",
          onPress: () => revokeDevice.mutate(d),
        },
      ],
    );
  };

  // Enrolment is native again (doc 14 C7 proper fix): the app now answers a
  // TOTP_REQUIRED login through /api/v1/auth/2fa/verify and the two-factor
  // screen, so turning 2FA on here no longer locks the owner out of the app.
  const startEnroll = useMutation({
    mutationFn: () =>
      api.request<EnrollmentPreview>("/api/account/2fa/start", { method: "POST" }),
    onSuccess: (p) => {
      setError(null);
      setPreview(p);
      setStatus("enrolling");
    },
    onError: (e) => setError(errorText(e, t("app.accountSecurity.errors.startFailed"))),
  });

  const confirmEnroll = useMutation({
    mutationFn: () =>
      api.request<{ recoveryCodes?: string[] }>("/api/account/2fa/enable", {
        method: "POST",
        body: { secret: preview?.secret, code },
      }),
    onSuccess: (body) => {
      setError(null);
      setRecoveryCodes(body.recoveryCodes ?? []);
      setStatus("showingCodes");
      setCode("");
    },
    onError: (e) => setError(errorText(e, t("app.accountSecurity.errors.enableFailed"))),
  });

  const regenerate = useMutation({
    mutationFn: () =>
      api.request<{ recoveryCodes?: string[] }>("/api/account/2fa/regenerate", {
        method: "POST",
        body: { password, code },
      }),
    onSuccess: (body) => {
      setError(null);
      setRecoveryCodes(body.recoveryCodes ?? []);
      setStatus("showingCodes");
      setPassword("");
      setCode("");
    },
    onError: (e) => setError(errorText(e, t("app.accountSecurity.errors.regenerateFailed"))),
  });

  const disable = useMutation({
    mutationFn: () =>
      api.request("/api/account/2fa/disable", {
        method: "POST",
        body: { password, code },
      }),
    onSuccess: () => {
      setError(null);
      setStatus("off");
      setPassword("");
      setCode("");
    },
    onError: (e) => setError(errorText(e, t("app.accountSecurity.errors.disableFailed"))),
  });

  const scheduleDelete = useMutation({
    mutationFn: () =>
      api.request<{ scheduledAt?: string }>("/api/account/delete", {
        method: "POST",
        body: { confirmSlug: slug.trim() },
      }),
    onSuccess: (body) => {
      setError(null);
      setScheduledAt(body.scheduledAt ?? null);
    },
    onError: (e) => setError(errorText(e, t("app.accountSecurity.delete.errors.genericError"))),
  });

  const cancelDelete = useMutation({
    mutationFn: () => api.request("/api/account/delete/cancel", { method: "POST" }),
    onSuccess: () => {
      setScheduledAt(null);
      setSlug("");
    },
    onError: (e) => setError(errorText(e, t("app.accountSecurity.delete.errors.genericError"))),
  });

  const revokeAll = useMutation({
    mutationFn: () =>
      api.request("/api/account/sessions/revoke-all", { method: "POST" }),
    // The call kills this device's session too, by design — so the only
    // correct next step is the login screen.
    onSettled: () => {
      void signOut().catch(() => undefined);
    },
  });

  const confirmRevokeAll = () => {
    Alert.alert(
      t("app.accountSecurity.revoke.title"),
      t("mobile.security.signOutEverywhereConfirm"),
      [
        { text: t("app.common.cancel"), style: "cancel" },
        {
          text: t("app.accountSecurity.revoke.button"),
          style: "destructive",
          onPress: () => revokeAll.mutate(),
        },
      ],
    );
  };

  const refresh = () => {
    void devicesQuery.refetch();
    if (isOwner) void statusQuery.refetch();
  };

  const header = (
    <SettingsHeader
      parentLabel={t("app.settingsPage.title")}
      title={t("app.accountSecurity.heading")}
      subtitle={t("app.accountSecurity.subhead")}
    />
  );

  const devices = devicesQuery.data ?? [];
  const devicesCard = (
    <Card>
      <View style={styles.cardTitleRow}>
        <Text style={styles.bodyStrong}>{t("mobile.security.devices.title")}</Text>
        {devices.length > 0 ? (
          <Badge label={deviceCountLabel(devices.length)} />
        ) : null}
      </View>
      <Text style={styles.hint}>{t("mobile.security.devices.intro")}</Text>
      <View style={styles.deviceList}>
        {devicesQuery.isLoading ? (
          <ActivityIndicator color={colors.accent} />
        ) : devicesQuery.isError ? (
          <View style={styles.stackTight}>
            <Text style={styles.errorInline}>{t("mobile.security.devices.loadFailed")}</Text>
            <Button
              label={t("app.common.retry")}
              variant="outline"
              onPress={() => void devicesQuery.refetch()}
              loading={devicesQuery.isRefetching}
            />
          </View>
        ) : devices.length === 0 ? (
          <EmptyState title={t("mobile.security.devices.empty")} />
        ) : (
          devices.map((d, i) => (
            <View key={d.id} style={i > 0 ? styles.deviceDivider : undefined}>
              <DeviceRow
                device={d}
                onRevoke={confirmRevoke}
                revoking={revokeDevice.isPending && revokeDevice.variables?.id === d.id}
              />
            </View>
          ))
        )}
      </View>
    </Card>
  );

  const revokeAllCard = (
    <Card>
      <Text style={styles.bodyStrong}>{t("app.accountSecurity.revoke.title")}</Text>
      <Text style={styles.hint}>
        {t("app.accountSecurity.revoke.intro")}
      </Text>
      <View style={styles.stack}>
        <Button
          label={t("app.accountSecurity.revoke.button")}
          variant="outline"
          onPress={confirmRevokeAll}
          loading={revokeAll.isPending}
        />
      </View>
    </Card>
  );

  const banners = (
    <>
      {error ? (
        <Pressable onPress={() => setError(null)}>
          <Text style={styles.error}>{error}</Text>
        </Pressable>
      ) : null}
      {notice ? (
        <Pressable onPress={() => setNotice(null)}>
          <Text style={styles.notice}>{notice}</Text>
        </Pressable>
      ) : null}
    </>
  );

  if (!isOwner) {
    // Staff cannot touch 2FA or the account itself, but their own devices are
    // theirs to see and cut — the route scopes by user_id, not by role.
    return (
      <Screen onRefresh={refresh} refreshing={devicesQuery.isRefetching}>
        {header}
        {banners}
        <Card>
          <Text style={styles.body}>
            {t("app.accountSecurity.staffNotice")}
          </Text>
        </Card>
        {devicesCard}
        {revokeAllCard}
      </Screen>
    );
  }

  return (
    <Screen onRefresh={refresh} refreshing={devicesQuery.isRefetching}>
      {header}

      {banners}

      {status === null ? <ActivityIndicator color={colors.accent} /> : null}

      {status === "off" ? (
        <Card>
          <Text style={styles.body}>
            {t("mobile.settings.currentStatus")} <Text style={styles.bodyStrong}>{t("app.accountSecurity.statusOff")}</Text>
          </Text>
          <View style={styles.stack} testID="security-enable-2fa">
            <Button
              label={t("app.accountSecurity.enableButton")}
              onPress={() => startEnroll.mutate()}
              loading={startEnroll.isPending}
            />
          </View>
        </Card>
      ) : null}

      {status === "enrolling" && preview ? (
        <Card>
          <Text style={styles.body}>
            {t("app.accountSecurity.enrollStep1")}
          </Text>
          <View style={styles.stack}>
            <Button
              label={t("mobile.settings.openAuthApp")}
              variant="outline"
              onPress={() => void Linking.openURL(preview.otpauthUri)}
            />
            <Text style={styles.hint}>
              {t("app.accountSecurity.manualHint")}
            </Text>
            <Text selectable style={styles.mono}>
              {preview.secret.match(/.{1,4}/g)?.join(" ")}
            </Text>
            <Text style={styles.body}>
              {t("app.accountSecurity.enrollStep2")}
            </Text>
            <Field
              label={t("app.accountSecurity.codePlaceholder")}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              maxLength={6}
              keyboardType="number-pad"
            />
            <View style={styles.row}>
              <Button
                label={t("app.accountSecurity.cancel")}
                variant="ghost"
                onPress={() => {
                  setStatus("off");
                  setPreview(null);
                  setCode("");
                }}
                style={styles.flex1}
              />
              <Button
                label={t("app.accountSecurity.confirmEnroll")}
                onPress={() => confirmEnroll.mutate()}
                disabled={code.length !== 6}
                loading={confirmEnroll.isPending}
                style={styles.flex1}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {status === "showingCodes" ? (
        <Card>
          <Text style={styles.bodyStrong}>
            {t("app.accountSecurity.codesHeading")}
          </Text>
          <View style={styles.codes}>
            {recoveryCodes.map((c) => (
              <Text key={c} selectable style={styles.codeCell}>
                {c}
              </Text>
            ))}
          </View>
          <View style={styles.stack}>
            <Button label={t("app.accountSecurity.codesUnderstood")} onPress={() => setStatus("on")} />
          </View>
        </Card>
      ) : null}

      {status === "on" ? (
        <>
          <Card>
            <Text style={styles.body}>
              {t("mobile.settings.currentStatus")} <Text style={styles.bodyOn}>{t("app.accountSecurity.statusOn")}</Text>
            </Text>
            <View style={styles.stack}>
              <Text style={styles.bodyStrong}>{t("app.accountSecurity.regenerateHeading")}</Text>
              <Field
                label={t("app.accountSecurity.currentPasswordPlaceholder")}
                value={password}
                onChangeText={setPassword}
                secure
              />
              <Field
                label={t("app.accountSecurity.codePlaceholder")}
                value={code}
                onChangeText={setCode}
                placeholder="123456"
                maxLength={6}
                keyboardType="number-pad"
              />
              <Button
                label={t("app.accountSecurity.regenerate")}
                onPress={() => regenerate.mutate()}
                disabled={!password || code.length !== 6}
                loading={regenerate.isPending}
              />
            </View>
          </Card>

          <Card>
            <Text style={styles.dangerTitle}>{t("app.accountSecurity.disableHeading")}</Text>
            <Text style={styles.hint}>
              {t("app.accountSecurity.disableHint")}
            </Text>
            <View style={styles.stack}>
              <Button
                label={t("app.accountSecurity.disableButton")}
                variant="outline"
                onPress={() => disable.mutate()}
                disabled={!password || code.length !== 6}
                loading={disable.isPending}
              />
            </View>
          </Card>
        </>
      ) : null}

      {status === "on" || status === "off" ? (
        <>
          {devicesCard}
          {revokeAllCard}

          <Card>
            <Text style={styles.bodyStrong}>{t("app.accountSecurity.export.title")}</Text>
            <Text style={styles.hint}>
              {t("app.accountSecurity.export.intro")}
            </Text>
            <View style={styles.stack}>
              <Button label={t("app.accountSecurity.export.button")} variant="outline" disabled onPress={() => {}} />
              <Text style={styles.hint}>{t("mobile.common.webOnly")}</Text>
            </View>
          </Card>

          <Card style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>{t("app.accountSecurity.delete.title")}</Text>
            <Text style={styles.hint}>
              {t("app.accountSecurity.delete.intro")}
            </Text>
            {scheduledAt ? (
              <View style={styles.stack}>
                <Text style={styles.hint}>
                  {t("mobile.settings.deletionDate")}{" "}
                  <Text style={styles.mono}>{scheduledAt.slice(0, 10)}</Text>
                </Text>
                <Button
                  label={t("app.accountSecurity.delete.cancelButton")}
                  variant="outline"
                  onPress={() => cancelDelete.mutate()}
                  loading={cancelDelete.isPending}
                />
              </View>
            ) : (
              <View style={styles.stack}>
                <Text style={styles.hint}>
                  {t("app.accountSecurity.delete.confirmHint")}
                </Text>
                <Field
                  label={t("auth.signup.storeNameLabel")}
                  value={slug}
                  onChangeText={setSlug}
                  placeholder="my-store"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Button
                  label={t("app.accountSecurity.delete.startButton")}
                  variant="outline"
                  onPress={() => scheduleDelete.mutate()}
                  disabled={!slug.trim()}
                  loading={scheduleDelete.isPending}
                />
              </View>
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: {
    fontFamily: fonts.medium,
    fontSize: 13,
    backgroundColor: colors.dangerLight,
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    backgroundColor: colors.successLight,
    color: colors.successStrong,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  errorInline: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },

  body: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, lineHeight: 24, ...RTL_TEXT },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, lineHeight: 24, ...RTL_TEXT },
  bodyOn: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.successStrong },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, lineHeight: 20, ...RTL_TEXT },
  dangerTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.danger, marginBottom: spacing.sm, ...RTL_TEXT },
  dangerCard: { borderColor: colors.dangerLight },

  cardTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },

  stack: { gap: spacing.md, marginTop: spacing.lg },
  stackTight: { gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm },
  flex1: { flex: 1 },

  // ---- devices ----
  deviceList: { marginTop: spacing.md },
  deviceDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    minHeight: MIN_TOUCH,
  },
  deviceIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  deviceBody: { flex: 1, minWidth: 0, gap: 2 },
  deviceTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  deviceName: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  deviceMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  revoke: {
    minHeight: MIN_TOUCH,
    minWidth: 64,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.dangerLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  revokePressed: { backgroundColor: colors.dangerLight },
  revokeLabel: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 13, color: colors.danger },

  // Latin, machine-readable strings: left-to-right and on the platform's
  // default face, because Cairo has no monospace cut.
  mono: {
    fontSize: 15,
    color: colors.text,
    letterSpacing: 1,
    textAlign: "center",
    writingDirection: "ltr",
    backgroundColor: colors.neutralTint,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  codes: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.lg,
    backgroundColor: colors.neutralTint,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  codeCell: {
    width: "47%",
    fontSize: 14,
    color: colors.text,
    textAlign: "center",
    writingDirection: "ltr",
    paddingVertical: 4,
  },
});
