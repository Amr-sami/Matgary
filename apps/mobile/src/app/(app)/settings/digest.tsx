import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "@matgary/api-client";
import { CaretDown } from "phosphor-react-native";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack } from "@/components/ui/Chevron";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__settings-digest.png.
 *
 * Two shapes had to change for a phone, both for the reason rule 5 exists:
 *
 *  - The hour is a 24-option <select> on the web. RN has no Select, and a
 *    24-row picker modal for one number is worse than the thing it replaces,
 *    so the field expands into a chip grid — the same control the filter rows
 *    already use.
 *  - "رقم الواتساب" sits beside its save button on the web, and the capture
 *    shows the result: "حفظ الرقم" broken one word per line. Stacked here.
 */
interface ExtraRecipient {
  name: string;
  phone?: string | null;
  email?: string | null;
  locale?: "ar" | "en" | null;
}

interface DigestSettings {
  enabled: boolean;
  digestHour: number;
  ownerPhone: string | null;
  sendOnEmpty: boolean;
  emailFallback: boolean;
  extraRecipients: ExtraRecipient[];
  managersSubscribed: string[];
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

export default function DigestSettingsScreen() {
  const router = useRouter();
  const me = useSession((s) => s.me);

  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneDirty, setPhoneDirty] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [extra, setExtra] = useState<ExtraRecipient>({ name: "", phone: "", email: "" });
  const [previewBranch, setPreviewBranch] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["digest-settings"],
    queryFn: async () => {
      const res = await api.request<{ settings: DigestSettings }>(
        "/api/digest/settings",
      );
      return res.settings;
    },
  });

  const settings = q.data ?? null;

  // The phone input is uncontrolled by the server after first load — typing
  // must not be clobbered by a refetch, so it seeds once.
  useEffect(() => {
    if (settings && !phoneDirty) setPhoneInput(settings.ownerPhone ?? "");
  }, [settings, phoneDirty]);

  useEffect(() => {
    if (!previewBranch && me?.branch.id) setPreviewBranch(me.branch.id);
  }, [previewBranch, me?.branch.id]);

  const save = useMutation({
    mutationFn: async (patch: Partial<DigestSettings>) => {
      const res = await api.request<{ settings: DigestSettings }>(
        "/api/digest/settings",
        { method: "PATCH", body: patch },
      );
      return res.settings;
    },
    onSuccess: () => {
      setNotice({ tone: "ok", text: t("app.digestSettings.savedToast") });
      void q.refetch();
    },
    onError: () => setNotice({ tone: "err", text: t("app.digestSettings.errorToast") }),
  });

  const preview = useMutation({
    mutationFn: async (branchId: string) => {
      const res = await api.request<{ message: string }>("/api/digest/preview", {
        query: { branchId, locale: "ar" },
      });
      return res.message;
    },
    onSuccess: (message) => setPreviewText(message),
    onError: () => setNotice({ tone: "err", text: t("app.digestSettings.previewErrorToast") }),
  });

  const forbidden = q.error instanceof ApiError && q.error.kind === "forbidden";

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
        <Text style={styles.title}>{t("app.digestSettings.title")}</Text>
        <Text style={styles.subtitle}>
          {t("app.digestSettings.intro")}
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

      {forbidden ? (
        <Card>
          <Text style={styles.sectionHint}>
            {t("mobile.settings.digestPermission")}
          </Text>
        </Card>
      ) : !settings ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <>
          {/* تفعيل الملخص */}
          <Card>
            <View style={styles.enableRow}>
              <View style={styles.enableBody}>
                <Text style={styles.sectionTitle}>{t("app.digestSettings.enable.title")}</Text>
                <Text style={styles.sectionHint}>
                  {settings.enabled
                    ? t("mobile.settings.digestActive", { time: `${String(settings.digestHour).padStart(2, "0")}:00` })
                    : t("app.digestSettings.enable.offLine")}
                </Text>
              </View>
              <Button
                label={settings.enabled ? t("app.digestSettings.enable.disable") : t("app.digestSettings.enable.enable")}
                variant={settings.enabled ? "outline" : "primary"}
                onPress={() => save.mutate({ enabled: !settings.enabled })}
                loading={save.isPending}
                style={styles.smallButton}
              />
            </View>
          </Card>

          {/* رقم الواتساب الأساسي */}
          <Card title={t("app.digestSettings.phone.title")}>
            <Text style={styles.sectionHint}>
              {t("app.digestSettings.phone.intro")}
            </Text>
            <View style={styles.stack}>
              <Field
                label={t("app.digestSettings.phone.label")}
                value={phoneInput}
                onChangeText={(v) => {
                  setPhoneInput(v);
                  setPhoneDirty(true);
                }}
                placeholder={t("app.digestSettings.phone.placeholder")}
                keyboardType="phone-pad"
              />
              <Button
                label={t("app.digestSettings.phone.save")}
                variant="outline"
                disabled={!phoneDirty || save.isPending}
                onPress={() => {
                  save.mutate({ ownerPhone: phoneInput.trim() || null });
                  setPhoneDirty(false);
                }}
              />
            </View>
          </Card>

          {/* الميعاد */}
          <Card title={t("app.digestSettings.schedule.title")}>
            <Text style={styles.sectionHint}>
              {t("app.digestSettings.schedule.intro")}
            </Text>
            <Text style={styles.fieldLabel}>{t("app.digestSettings.schedule.hourLabel")}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: hoursOpen }}
              onPress={() => setHoursOpen((v) => !v)}
              style={styles.selectBox}
            >
              <Text numberOfLines={1} style={styles.selectValue}>
                {hh(settings.digestHour)}
              </Text>
              <CaretDown size={16} color={colors.textSecondary} />
            </Pressable>
            {hoursOpen ? (
              <View style={styles.hourGrid}>
                {HOURS.map((h) => (
                  <Chip
                    key={h}
                    label={hh(h)}
                    active={h === settings.digestHour}
                    onPress={() => {
                      setHoursOpen(false);
                      if (h !== settings.digestHour) save.mutate({ digestHour: h });
                    }}
                  />
                ))}
              </View>
            ) : null}
          </Card>

          {/* السلوك */}
          <Card title={t("app.digestSettings.behavior.title")}>
            <ToggleRow
              label={t("app.digestSettings.behavior.sendOnEmpty")}
              value={settings.sendOnEmpty}
              disabled={save.isPending}
              onChange={(v) => save.mutate({ sendOnEmpty: v })}
            />
            <ToggleRow
              label={t("app.digestSettings.behavior.emailFallback")}
              value={settings.emailFallback}
              disabled={save.isPending}
              onChange={(v) => save.mutate({ emailFallback: v })}
            />
          </Card>

          {/* مستقبلين إضافيين */}
          <Card title={t("app.digestSettings.extras.title")}>
            <Text style={styles.sectionHint}>
              {t("app.digestSettings.extras.intro")}
            </Text>
            {settings.extraRecipients.length === 0 ? (
              <Text style={styles.empty}>{t("app.digestSettings.extras.empty")}</Text>
            ) : (
              <View style={styles.recipients}>
                {settings.extraRecipients.map((r, i) => (
                  <View key={`${r.name}-${i}`} style={styles.recipientRow}>
                    <View style={styles.recipientBody}>
                      <Text numberOfLines={1} style={styles.recipientName}>
                        {r.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.recipientMeta}>
                        {[r.phone, r.email].filter(Boolean).join(" · ") || "—"}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("app.digestSettings.extras.delete")}
                      disabled={save.isPending}
                      onPress={() =>
                        save.mutate({
                          extraRecipients: settings.extraRecipients.filter(
                            (_, idx) => idx !== i,
                          ),
                        })
                      }
                      style={styles.removeButton}
                    >
                      <Text style={styles.removeLabel}>{t("app.digestSettings.extras.delete")}</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.stack}>
              <Field
                label={t("app.digestSettings.extras.nameLabel")}
                value={extra.name}
                onChangeText={(v) => setExtra({ ...extra, name: v })}
              />
              <Field
                label={t("app.digestSettings.extras.phoneLabel")}
                value={extra.phone ?? ""}
                onChangeText={(v) => setExtra({ ...extra, phone: v })}
                keyboardType="phone-pad"
              />
              <Field
                label={t("app.digestSettings.extras.emailLabel")}
                value={extra.email ?? ""}
                onChangeText={(v) => setExtra({ ...extra, email: v })}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Button
                label={t("app.digestSettings.extras.add")}
                variant="outline"
                disabled={!extra.name.trim() || save.isPending}
                onPress={() => {
                  save.mutate({
                    extraRecipients: [
                      ...settings.extraRecipients,
                      {
                        name: extra.name.trim(),
                        phone: extra.phone?.trim() || null,
                        email: extra.email?.trim() || null,
                      },
                    ],
                  });
                  setExtra({ name: "", phone: "", email: "" });
                }}
              />
            </View>
          </Card>

          {/* معاينة */}
          <Card title={t("app.digestSettings.preview.title")}>
            <Text style={styles.sectionHint}>
              {t("app.digestSettings.preview.intro")}
            </Text>
            <View style={styles.branchChips}>
              {(me?.branches ?? []).map((b) => (
                <Chip
                  key={b.id}
                  label={b.name}
                  active={b.id === previewBranch}
                  onPress={() => setPreviewBranch(b.id)}
                />
              ))}
            </View>
            <Button
              label={t("app.digestSettings.preview.title")}
              variant="outline"
              disabled={!previewBranch || preview.isPending}
              loading={preview.isPending}
              onPress={() => previewBranch && preview.mutate(previewBranch)}
            />
            {previewText ? (
              <Text style={styles.previewBox}>{previewText}</Text>
            ) : null}
          </Card>
        </>
      )}
    </Screen>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.border }}
      />
    </View>
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

  enableRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  enableBody: { flex: 1, minWidth: 0, gap: 4 },
  smallButton: {
    flexShrink: 0,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
  },

  sectionTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  sectionHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 20,
    ...RTL_TEXT,
  },
  stack: { gap: spacing.md, marginTop: spacing.lg },

  fieldLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  selectBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  selectValue: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  hourGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
  },
  toggleLabel: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text,
    ...RTL_TEXT,
  },

  empty: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: spacing.md,
    ...RTL_TEXT,
  },
  recipients: { gap: spacing.sm, marginTop: spacing.md },
  recipientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  recipientBody: { flex: 1, minWidth: 0 },
  recipientName: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  recipientMeta: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  removeButton: {
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    flexShrink: 0,
  },
  removeLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger },

  branchChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  previewBox: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 22,
    color: colors.neutralText,
    ...RTL_TEXT,
  },
});
