import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, settings } from "@matgary/api-client";
import { CameraIcon as Camera } from "phosphor-react-native/src/icons/Camera";
import { StorefrontIcon as Storefront } from "phosphor-react-native/src/icons/Storefront";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { money } from "@/lib/format";
import { useLogoPicker } from "@/lib/useLogoPicker";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Store info — the "Shop info" + "Loyalty programme" sections of the web
 * settings page (apps/web/app/settings/page.tsx), split out per doc 02 §1.1
 * row 20. The web page has no address / tax / registration / currency fields
 * (ShopSettingsDto carries only shopName + shopPhone), so neither does this.
 *
 * Loyalty lives here because row 20 lists it as a settings row but no
 * `settings/loyalty` route was registered; the three fields ride on the same
 * PATCH /api/settings the store fields use.
 *
 * The receipt logo is rendered read-only: no image picker is installed, and
 * the web pipeline resizes to a ≤256 KB data:image before upload. Changing it
 * happens on the web.
 *
 * Owner-only — deliberately STRICTER than the web. The web page is reached
 * via the `view_settings` permission and does not `isOwner`-gate the shop-info
 * or loyalty sections (only its Branches/Activity tiles and the template-sync
 * button check isOwner). PATCH /api/settings only runs
 * requireTenantWithBranch — no permission check — so until the server
 * enforces one (spec §2.13 server fix, still open), the mobile Settings index
 * marks this tile ownerOnly and the screen re-checks it here.
 */
type ShopSettings = settings.ShopSettings;
type Draft = Pick<ShopSettings, (typeof settings.STORE_SETTINGS_FIELDS)[number]>;

const pickDraft = (s: ShopSettings): Draft => ({
  shopName: s.shopName,
  shopPhone: s.shopPhone,
  loyaltyEnabled: s.loyaltyEnabled,
  loyaltyPointsPerEgp: s.loyaltyPointsPerEgp,
  loyaltyEgpPerPoint: s.loyaltyEgpPerPoint,
});

/**
 * "0.1" → 0.1; "" / garbage → 0. Deliberately does NOT clamp to the server
 * ceiling: the TextInput keeps the raw text, so a silent clamp would show
 * "150" while saving 100. Values above LOYALTY_*_MAX are flagged inline and
 * block Save instead (the web relies on the number input's own validation).
 */
const parseRate = (raw: string) => {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

export default function StoreSettingsScreen() {
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const branchId = me?.branch.id ?? null;
  const isOwner = me?.isOwner ?? false;

  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Rate inputs keep their raw text so "0." doesn't snap to "0" mid-typing.
  const [pointsText, setPointsText] = useState("");
  const [egpText, setEgpText] = useState("");

  const q = useQuery({
    queryKey: ["shop-settings", branchId],
    queryFn: () => settings.getShopSettings(api),
    enabled: isOwner,
  });
  const server = q.data?.data ?? null;
  const logo = useLogoPicker(() => qc.invalidateQueries({ queryKey: ["shop-settings"] }));

  const dirty = useMemo(
    () =>
      !!server &&
      !!draft &&
      !settings.settingsFieldsEqual(server, draft, settings.STORE_SETTINGS_FIELDS),
    [server, draft],
  );

  // Seed the draft from the server once, and again after each refetch as long
  // as the operator hasn't typed — a background refetch must never clobber
  // half-typed edits.
  useEffect(() => {
    if (server && (!draft || !dirty)) {
      const d = pickDraft(server);
      setDraft(d);
      setPointsText(String(d.loyaltyPointsPerEgp));
      setEgpText(String(d.loyaltyEgpPerPoint));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = useMutation({
    mutationFn: async () => {
      if (!server || !draft) return;
      const patch = settings.diffSettings(server, draft, settings.STORE_SETTINGS_FIELDS);
      if (patch.shopName !== undefined) patch.shopName = patch.shopName.trim();
      if (patch.shopPhone !== undefined) patch.shopPhone = patch.shopPhone.trim();
      await settings.updateShopSettings(api, patch);
      return patch;
    },
    onSuccess: async (sent) => {
      // Reseed the trimmed strings from what was sent. Otherwise a trailing
      // space in the draft never equals the trimmed value the refetch returns,
      // the screen stays "unsaved" forever, and the !dirty reseed never fires.
      setDraft((d) =>
        d && sent
          ? {
              ...d,
              shopName: sent.shopName ?? d.shopName,
              shopPhone: sent.shopPhone ?? d.shopPhone,
            }
          : d,
      );
      setNotice({ tone: "ok", text: t("app.settingsPage.toast.saveSuccess") });
      await qc.invalidateQueries({ queryKey: ["shop-settings"] });
      // The dashboard header + receipts read the shop name too.
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => {
      const text =
        e instanceof ApiError && e.kind === "forbidden"
          ? t("mobile.common.forbidden")
          : t("app.settingsPage.toast.saveFailed");
      setNotice({ tone: "err", text });
    },
  });

  const discard = () => {
    if (!server) return;
    const d = pickDraft(server);
    setDraft(d);
    setPointsText(String(d.loyaltyPointsPerEgp));
    setEgpText(String(d.loyaltyEgpPerPoint));
  };

  const forbidden = q.error instanceof ApiError && q.error.kind === "forbidden";

  // Server ceilings (PATCH rejects anything above them). Checked regardless of
  // the toggle: a rate typed while loyalty was on is still sent after it is
  // switched off, so Save must stay blocked until it is fixed.
  const pointsTooHigh = !!draft && draft.loyaltyPointsPerEgp > settings.LOYALTY_POINTS_PER_EGP_MAX;
  const egpTooHigh = !!draft && draft.loyaltyEgpPerPoint > settings.LOYALTY_EGP_PER_POINT_MAX;
  const rateInvalid = pointsTooHigh || egpTooHigh;

  // Same worked example as the web: a 100 EGP invoice.
  const earned = draft ? Math.floor(100 * draft.loyaltyPointsPerEgp) : 0;
  const exampleValue = draft ? money(earned * draft.loyaltyEgpPerPoint) : money(0);

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <SettingsHeader
        parentLabel={t("app.settingsPage.title")}
        title={t("app.settingsPage.shopInfo.section")}
        subtitle={t("mobile.settings.storeIntro")}
      />

      {notice ? (
        <Pressable onPress={() => setNotice(null)}>
          <Text
            style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}
          >
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {!isOwner || forbidden ? (
        <Card>
          <Text style={styles.sectionHint}>{t("mobile.common.ownerOnly")}</Text>
        </Card>
      ) : q.isError ? (
        <Card>
          <Text style={styles.sectionHint}>{t("mobile.settings.loadFailed")}</Text>
          <Button
            label={t("mobile.settings.retry")}
            variant="outline"
            onPress={() => void q.refetch()}
            style={styles.stackTop}
          />
        </Card>
      ) : !server || !draft ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <>
          {/* معلومات المتجر — no card title: the page H1 60pt above already says it. */}
          <Card>
            <View style={styles.stack}>
              <Field
                label={t("app.settingsPage.shopInfo.shopNameLabel")}
                value={draft.shopName}
                onChangeText={(v) => update("shopName", v)}
                maxLength={settings.SHOP_NAME_MAX}
                autoCapitalize="words"
              />
              <View style={styles.fieldGroup}>
                <Field
                  label={t("app.settingsPage.shopInfo.phoneLabel")}
                  value={draft.shopPhone}
                  onChangeText={(v) => update("shopPhone", v)}
                  placeholder="01500228266"
                  keyboardType="phone-pad"
                  maxLength={settings.SHOP_PHONE_MAX}
                  ltr
                />
                <Text style={styles.fieldHint}>{t("app.settingsPage.shopInfo.phoneHint")}</Text>
              </View>
            </View>
          </Card>

          {/* الشعار — اختيار + رفع */}
          <Card title={t("mobile.settings.logoTitle")}>
            <View style={styles.logoRow}>
              {server.receiptLogoUrl ? (
                <Image
                  source={{ uri: server.receiptLogoUrl }}
                  accessibilityLabel={t("app.receiptDesigner.logoAlt")}
                  resizeMode="contain"
                  style={styles.logo}
                />
              ) : (
                <View style={[styles.logo, styles.logoEmpty]}>
                  <Storefront size={28} color={colors.textSecondary} />
                </View>
              )}
              <View style={styles.logoBody}>
                <Text style={styles.sectionTitle}>
                  {server.receiptLogoUrl
                    ? t("app.receiptDesigner.logoAlt")
                    : t("app.receiptDesigner.logoEmptyTitle")}
                </Text>
                <Text style={styles.sectionHint}>{t("mobile.settings.logoHint")}</Text>
                {/* The CTA belongs to the title/hint column it describes, not
                    under the placeholder square — and it is the shared Button
                    like every sibling CTA, not a one-off pill. */}
                <Button
                  variant="outline"
                  icon={Camera}
                  label={server.receiptLogoUrl ? t("mobile.settings.changeLogo") : t("mobile.settings.addLogo")}
                  loading={logo.status === "uploading"}
                  disabled={logo.status === "uploading"}
                  onPress={() => void logo.pick()}
                  style={styles.logoBtn}
                />
              </View>
            </View>
            {logo.message ? (
              <Text style={[styles.logoMsg, logo.status === "error" && styles.logoMsgError]}>{logo.message}</Text>
            ) : null}
          </Card>

          {/* برنامج الولاء */}
          <Card title={t("app.settingsPage.loyalty.title")}>
            <ToggleRow
              label={
                draft.loyaltyEnabled
                  ? t("app.settingsPage.loyalty.enabled")
                  : t("app.settingsPage.loyalty.disabled")
              }
              hint={t("app.settingsPage.loyalty.subtitle")}
              value={draft.loyaltyEnabled}
              onValueChange={(v) => update("loyaltyEnabled", v)}
            />

            {draft.loyaltyEnabled ? (
              <View style={styles.stackAfterTitle}>
                <Field
                  label={t("app.settingsPage.loyalty.pointsPerEgp")}
                  value={pointsText}
                  onChangeText={(v) => {
                    setPointsText(v);
                    update("loyaltyPointsPerEgp", parseRate(v));
                  }}
                  placeholder={t("app.settingsPage.loyalty.pointsPerEgpPlaceholder")}
                  keyboardType="decimal-pad"
                  ltr
                />
                {pointsTooHigh ? (
                  <Text style={styles.fieldError}>
                    {t("mobile.settings.loyaltyRateMax", {
                      max: String(settings.LOYALTY_POINTS_PER_EGP_MAX),
                    })}
                  </Text>
                ) : null}
                <Field
                  label={t("app.settingsPage.loyalty.egpPerPoint")}
                  value={egpText}
                  onChangeText={(v) => {
                    setEgpText(v);
                    update("loyaltyEgpPerPoint", parseRate(v));
                  }}
                  placeholder={t("app.settingsPage.loyalty.egpPerPointPlaceholder")}
                  keyboardType="decimal-pad"
                  ltr
                />
                {egpTooHigh ? (
                  <Text style={styles.fieldError}>
                    {t("mobile.settings.loyaltyRateMax", {
                      max: String(settings.LOYALTY_EGP_PER_POINT_MAX),
                    })}
                  </Text>
                ) : null}

                <View style={styles.example}>
                  <Text style={styles.exampleLabel}>
                    {t("app.settingsPage.loyalty.exampleLabel")}
                  </Text>
                  <Text style={styles.exampleBody}>
                    {t("mobile.settings.loyaltyExample", {
                      earned: String(earned),
                      value: exampleValue,
                    })}
                  </Text>
                  {draft.loyaltyPointsPerEgp === 0 && draft.loyaltyEgpPerPoint === 0 ? (
                    <View style={styles.warnRow}>
                      <WarningCircle size={14} color={colors.warningStrong} weight="fill" />
                      <Text style={styles.warnText}>{t("mobile.settings.loyaltyWarning")}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}
          </Card>

          {/* شريط الحفظ */}
          <View style={styles.saveBar}>
            <Text
              style={[
                styles.dirtyText,
                dirty && styles.dirtyTextActive,
                dirty && rateInvalid && styles.dirtyTextError,
              ]}
            >
              {dirty && rateInvalid
                ? t("mobile.settings.fixFieldsFirst")
                : dirty
                  ? t("app.settingsPage.dirty")
                  : t("app.settingsPage.clean")}
            </Text>
            <View style={styles.saveButtons}>
              {dirty ? (
                <Button
                  label={t("mobile.settings.discard")}
                  variant="ghost"
                  disabled={save.isPending}
                  onPress={discard}
                />
              ) : null}
              <Button
                label={t("app.settingsPage.save")}
                disabled={!dirty || rateInvalid || save.isPending}
                loading={save.isPending}
                onPress={() => save.mutate()}
              />
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
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

  sectionTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  sectionHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 20,
    ...RTL_TEXT,
  },
  // No top inset: the Shop-info Card has no title, so the stack starts at the
  // card's own padding like the logo card does. The loyalty fields sit under
  // the enable row and keep theirs.
  stack: { gap: spacing.md },
  stackAfterTitle: { gap: spacing.md, marginTop: spacing.md },
  stackTop: { marginTop: spacing.md },
  fieldGroup: { gap: spacing.xs },
  fieldHint: { fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary, ...RTL_TEXT },
  fieldError: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.danger,
    marginTop: -spacing.xs,
    ...RTL_TEXT,
  },

  logoBtn: { alignSelf: "flex-start", marginTop: spacing.xs },
  logoMsg: { fontFamily: fonts.regular, fontSize: 13, color: colors.success, marginTop: spacing.xs, ...RTL_TEXT },
  logoMsgError: { color: colors.danger },
  logoRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.lg },
  logo: { width: 72, height: 72, borderRadius: radius.lg, backgroundColor: colors.neutralTint },
  logoEmpty: { alignItems: "center", justifyContent: "center" },
  logoBody: { flex: 1, minWidth: 0, gap: 4 },

  example: {
    backgroundColor: colors.accentLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 4,
  },
  exampleLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.text, ...RTL_TEXT },
  exampleBody: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 20,
    ...RTL_TEXT,
  },
  warnRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  warnText: { flex: 1, fontFamily: fonts.medium, fontSize: 12, color: colors.warningStrong, ...RTL_TEXT },

  saveBar: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dirtyText: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  dirtyTextActive: { ...RTL_TEXT, color: colors.warningStrong, fontFamily: fonts.medium },
  dirtyTextError: { color: colors.danger },
  saveButtons: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, minHeight: MIN_TOUCH },
});
