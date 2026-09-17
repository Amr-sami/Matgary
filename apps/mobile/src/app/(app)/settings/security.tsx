import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CaretRight, ShieldCheck } from "phosphor-react-native";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__account-security.png (/account/security on the web).
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

export default function SecurityScreen() {
  const router = useRouter();
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

  const statusQuery = useQuery({
    queryKey: ["2fa-status"],
    queryFn: () =>
      api
        .request<{ enabled: boolean }>("/api/account/2fa-status")
        .catch(() => ({ enabled: false })),
  });

  // Seeds ONCE. A cached answer (react-query holds it for 30s) still lands
  // here on a re-entry, which a side effect inside queryFn would have missed.
  useEffect(() => {
    if (status === null && statusQuery.data) {
      setStatus(statusQuery.data.enabled ? "on" : "off");
    }
  }, [status, statusQuery.data]);

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

  const header = (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        hitSlop={12}
        style={styles.back}
      >
        <CaretRight size={16} color={colors.textSecondary} />
        <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
      </Pressable>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t("app.accountSecurity.heading")}</Text>
        <ShieldCheck size={26} color={colors.accent} />
      </View>
      <Text style={styles.subtitle}>
        {t("app.accountSecurity.subhead")}
      </Text>
    </View>
  );

  if (!isOwner) {
    return (
      <Screen>
        {header}
        <Card>
          <Text style={styles.body}>
            {t("app.accountSecurity.staffNotice")}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      {header}

      {error ? (
        <Pressable onPress={() => setError(null)}>
          <Text style={styles.error}>{error}</Text>
        </Pressable>
      ) : null}

      {status === null ? <ActivityIndicator color={colors.accent} /> : null}

      {status === "off" ? (
        <Card>
          <Text style={styles.body}>
            {t("mobile.settings.currentStatus")} <Text style={styles.bodyStrong}>{t("app.accountSecurity.statusOff")}</Text>
          </Text>
          <View style={styles.stack}>
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
          <Card style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>{t("app.accountSecurity.delete.title")}</Text>
            <Text style={styles.hint}>
              {t("app.accountSecurity.delete.intro")}
            </Text>
            {scheduledAt ? (
              <View style={styles.stack}>
                <Text style={styles.hint}>
                  موعد الحذف:{" "}
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

          <Card>
            <Text style={styles.bodyStrong}>{t("app.accountSecurity.revoke.title")}</Text>
            <Text style={styles.hint}>
              {t("app.accountSecurity.revoke.intro")}
            </Text>
            <View style={styles.stack}>
              <Button
                label={t("app.accountSecurity.revoke.button")}
                variant="outline"
                onPress={() => revokeAll.mutate()}
                loading={revokeAll.isPending}
              />
            </View>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  title: {
    flex: 1,
    fontFamily: fonts.bold,
    fontSize: 26,
    color: colors.text,
    ...RTL_TEXT,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },

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

  body: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, lineHeight: 24, ...RTL_TEXT },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, lineHeight: 24, ...RTL_TEXT },
  bodyOn: { fontFamily: fonts.semibold, fontSize: 14, color: colors.successStrong },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, lineHeight: 20, ...RTL_TEXT },
  dangerTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.danger, marginBottom: spacing.sm, ...RTL_TEXT },
  dangerCard: { borderColor: colors.dangerLight },

  stack: { gap: spacing.md, marginTop: spacing.lg },
  row: { flexDirection: "row", gap: spacing.sm },
  flex1: { flex: 1 },

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
