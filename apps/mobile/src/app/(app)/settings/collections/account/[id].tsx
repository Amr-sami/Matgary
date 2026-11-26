import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SkeletonFormField } from "@/components/ui/skeleton";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { collections } from "@matgary/api-client";

import { api } from "@/api/client";
import { localYmd, newIdempotencyKey, useCollectionAccounts, useCollectionSettings } from "@/collections/queries";
import { collectionsScreenGate } from "@/components/collections/setup/access";
import { ProviderSheet } from "@/components/collections/setup/ProviderSheet";
import {
  draftFromDto,
  emptyDraft,
  ipaFromDraft,
  parseThreshold,
  patchBody,
  validateAccountDraft,
  type AccountColumn,
  type AccountDraft,
  type AccountErrors,
  type Rail,
} from "@/components/collections/setup/account-form";
import { ACCOUNT_RULES, PROVIDER_RAILS } from "@/components/collections/setup/account-rules";
import { accountSaveErrorText, collectionsErrorText, serverFieldError } from "@/components/collections/setup/errors";
import { useSetupNotice } from "@/components/collections/setup/notice";
import { COLLECTION_ACCOUNTS_ROOT } from "@/components/collections/setup/queries";
import { useCollectionsAccess, type CollectionsSetupAccess } from "@/components/collections/setup/useCollectionsAccess";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronForward } from "@/components/ui/Chevron";
import { DateField } from "@/components/ui/DateField";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { t } from "@/i18n";
import { decodeRouteParam } from "@/lib/customer-phone";
import { goBack } from "@/lib/nav";
import { useOffline } from "@/stores/offline";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Account = collections.CollectionAccountDTO;

const HUB = "/settings/collections";
/** The server's review_threshold default (03 §B.2.1, Q16) — the confirm text's fallback amount. */
const DEFAULT_REVIEW_THRESHOLD = 5000;

/**
 * Digital collections — one receiving account (doc 15 spec 09 §4.4, M1).
 *
 * `/settings/collections/account/new?rail=instapay|wallet` creates;
 * `/settings/collections/account/<id>` edits an account of the active branch,
 * read from the `["collection-accounts", branchId]` cache (refetched once if
 * missing; 03 §B.4 has no single-account GET). The rail never changes after
 * creation, and neither does the provider (05's PATCH schema has neither: a
 * different bank or wallet is another account).
 *
 * Save: POST with one Idempotency-Key minted when the screen mounts (reused
 * on retry), or PATCH with the changed fields only; then every branch's
 * account list is invalidated (the POS picker included) and the screen pops
 * back to the hub, which shows the notice.
 */
export default function CollectionAccountScreen() {
  const params = useLocalSearchParams<{ id: string; rail?: string }>();
  const id = decodeRouteParam(params.id);
  const isNew = id === "new";
  const railParam = decodeRouteParam(params.rail);
  const newRail: Rail | null = railParam === "instapay" || railParam === "wallet" ? railParam : null;

  const access = useCollectionsAccess();
  const online = useOffline((s) => s.online);
  const gate = collectionsScreenGate(access);
  const enabled = gate === "ok";
  const accountsQ = useCollectionAccounts(enabled);
  const accounts = accountsQ.accounts;
  const found = !isNew && accounts ? (accounts.find((a) => a.id === id) ?? null) : null;
  // Once shown, the form stays on screen even if a refetch drops the row (the
  // archive this screen just did, or one made on the web meanwhile — a save
  // then answers COLLECTION_ACCOUNT_NOT_FOUND instead of the typing vanishing).
  const [seen, setSeen] = useState<Account | null>(null);
  // "Adjusting state while rendering" (react.dev): remember the last row seen.
  if (found && found !== seen) setSeen(found);
  const existing = found ?? seen;

  // A deep link to an account this cache does not hold yet: refetch ONCE
  // before saying "not in this branch".
  const refetched = useRef(false);
  const [refetchDone, setRefetchDone] = useState(false);
  useEffect(() => {
    if (isNew || !enabled || existing || !accounts || refetched.current) return;
    refetched.current = true;
    void accountsQ.query.refetch().finally(() => setRefetchDone(true));
  }, [isNew, enabled, existing, accounts, accountsQ.query]);

  const title = isNew
    ? newRail === "wallet"
      ? t("app.collectionsSettings.form.newTitleWallet")
      : t("app.collectionsSettings.form.newTitleInstapay")
    : t("app.collectionsSettings.form.editTitle");

  const header = (
    <SettingsHeader
      parentLabel={t("app.collectionsSettings.title")}
      title={title}
      subtitle={existing ? existing.label : undefined}
      fallback={HUB}
    />
  );

  let blocker: ReactNode = null;
  if (gate === "noPermission") blocker = t("app.collectionsSettings.noPermission");
  else if (gate === "unavailable") blocker = t("app.collectionsSettings.unavailable");
  else if (isNew && !newRail) blocker = t("app.collectionsSettings.form.notFound");
  else if (!isNew && !existing) {
    const waiting = !accounts ? accountsQ.isLoading : !refetchDone;
    if (waiting) {
      return (
        <Screen header={header}>
          <SkeletonFormField />
          <SkeletonFormField />
          <SkeletonFormField />
        </Screen>
      );
    }
    blocker = accounts ? t("app.collectionsSettings.form.notFound") : t("mobile.settings.loadFailed");
  }
  if (blocker) {
    return (
      <Screen header={header}>
        <Card>
          <Text style={styles.hint} testID="collection-account-form-blocked">
            {blocker}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <AccountForm
        key={existing?.id ?? `new-${newRail}`}
        account={existing}
        rail={existing?.rail ?? (newRail as Rail)}
        access={access}
        online={online}
      />
    </Screen>
  );
}

function AccountForm({
  account,
  rail,
  access,
  online,
}: {
  account: Account | null;
  rail: Rail;
  access: CollectionsSetupAccess;
  online: boolean;
}) {
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const isNew = account == null;
  const activeBranchId = me?.branch?.id ?? null;
  // The branch switch for "Automatic confirmation is off in the branch
  // settings" (only read with L2).
  const settingsQ = useCollectionSettings(access.ingest);

  const [initial] = useState<AccountDraft>(() => (account ? draftFromDto(account) : emptyDraft(rail, activeBranchId)));
  const [draft, setDraft] = useState<AccountDraft>(initial);
  const [errors, setErrors] = useState<AccountErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  // One key per screen visit, reused for every retry of the create (09 §4.4).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const today = localYmd();

  const set = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K], column?: AccountColumn) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (column) {
      setErrors((e) => {
        if (!e[column] && !e.identity) return e;
        const next = { ...e };
        delete next[column];
        delete next.identity;
        return next;
      });
    }
  };

  const onSaved = (text: string) => {
    useSetupNotice.getState().put({ tone: "ok", text });
    goBack(HUB);
    // Prefix: every branch's picker (the POS included) and the hub refresh
    // without a relaunch (09 §6.8).
    void qc.invalidateQueries({ queryKey: COLLECTION_ACCOUNTS_ROOT });
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      account
        ? collections.updateAccount(api, account.id, body as collections.AccountPatchBody)
        : collections.createAccount(api, body as unknown as collections.AccountCreateBody, idempotencyKey),
    onSuccess: () =>
      onSaved(isNew ? t("app.collectionsSettings.form.created") : t("app.collectionsSettings.form.saved")),
    onError: (e) => {
      const field = serverFieldError(e);
      if (field) setErrors((prev) => ({ ...prev, [field.column]: field.error }));
      setNotice(accountSaveErrorText(e));
    },
  });

  const archive = useMutation({
    mutationFn: () => collections.archiveAccount(api, account!.id),
    onSuccess: () => onSaved(t("app.collectionsSettings.form.archived")),
    onError: (e) => setNotice(collectionsErrorText(e, t("app.collectionsSettings.form.saveFailed"))),
  });

  const busy = save.isPending || archive.isPending;

  const submit = () => {
    setNotice(null);
    const opts = { includeL2: access.ingest, today, providers: PROVIDER_RAILS };
    const result = isNew
      ? validateAccountDraft(draft, ACCOUNT_RULES, opts)
      : patchBody(initial, draft, ACCOUNT_RULES, opts);
    if (!result.ok) {
      setErrors(result.errors);
      setNotice(t("mobile.settings.fixFieldsFirst"));
      return;
    }
    setErrors({});
    if (!isNew && Object.keys(result.body).length === 0) {
      goBack(HUB); // nothing changed
      return;
    }
    save.mutate(result.body);
  };

  const confirmArchive = () => {
    if (!account) return;
    Alert.alert(
      t("app.collectionsSettings.form.archiveConfirmTitle", { label: account.label }),
      t("app.collectionsSettings.form.archiveConfirmBody"),
      [
        { text: t("app.collectionsSettings.form.cancel"), style: "cancel" },
        { text: t("app.collectionsSettings.form.archive"), style: "destructive", onPress: () => archive.mutate() },
      ],
    );
  };

  const setAutoConfirm = (on: boolean) => {
    if (!on) {
      set("autoConfirmEnabled", false);
      return;
    }
    // Q21: turning it on asks first and recommends a week of correct suggestions.
    const amount = parseThreshold(draft.reviewThreshold) ?? account?.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
    Alert.alert(
      t("app.collectionsSettings.form.fields.autoConfirmEnabled.confirmTitle"),
      t("app.collectionsSettings.form.fields.autoConfirmEnabled.confirmBody", { amount: String(amount) }),
      [
        { text: t("app.collectionsSettings.form.cancel"), style: "cancel" },
        { text: t("app.common.confirm"), onPress: () => set("autoConfirmEnabled", true) },
      ],
    );
  };

  const err = (column: AccountColumn) =>
    errors[column] ? (
      <Text style={styles.error} testID={`collection-account-form-${column}-error`}>
        {t(`app.collectionsSettings.form.${errors[column]}`)}
      </Text>
    ) : null;

  const ipa = rail === "instapay" ? ipaFromDraft(draft, ACCOUNT_RULES) : null;
  const branchAutoConfirmOff = access.ingest && settingsQ.data ? !settingsQ.data.collectionsAutoConfirmEnabled : false;

  return (
    <>
      {notice ? (
        <Pressable onPress={() => setNotice(null)} testID="collection-account-form-notice">
          <Text style={[styles.notice, styles.noticeErr]}>{notice}</Text>
        </Pressable>
      ) : null}
      {!online ? <Text style={[styles.notice, styles.noticeWarn]}>{t("mobile.common.offline")}</Text> : null}

      <Card>
        <View style={styles.form}>
          <PickerRow
            testID="collection-account-form-provider"
            label={
              rail === "instapay"
                ? t("app.collectionsSettings.form.fields.provider.bank")
                : t("app.collectionsSettings.form.fields.provider.wallet")
            }
            value={
              draft.provider
                ? t(`app.collections.vocab.providers.${draft.provider}`)
                : t("app.collectionsSettings.form.fields.provider.pickTitle")
            }
            placeholder={!draft.provider}
            // Fixed after creation: 05's PATCH has no provider.
            disabled={!isNew || busy}
            onPress={() => setProviderOpen(true)}
          />
          {err("provider")}

          <Field
            testID="collection-account-form-label"
            label={t("app.collectionsSettings.form.fields.label.label")}
            placeholder={t("app.collectionsSettings.form.fields.label.placeholder")}
            value={draft.label}
            onChangeText={(v) => set("label", v, "label")}
            maxLength={80}
            editable={!busy}
          />
          {err("label")}

          <Field
            testID="collection-account-form-holder_name"
            label={t("app.collectionsSettings.form.fields.holderName.label")}
            value={draft.holderName}
            onChangeText={(v) => set("holderName", v, "holder_name")}
            maxLength={100}
            editable={!busy}
          />
          <Text style={styles.hint}>{t("app.collectionsSettings.form.fields.holderName.hint")}</Text>
          {err("holder_name")}

          {rail === "instapay" ? (
            <>
              <Field
                testID="collection-account-form-ipa_link"
                label={t("app.collectionsSettings.form.fields.ipaLink.label")}
                value={draft.ipaText}
                onChangeText={(v) => set("ipaText", v, "ipa_link")}
                placeholder="https://ipn.eg/S/…"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                multiline
                ltr
                editable={!busy}
              />
              <Text style={styles.hint}>{t("app.collectionsSettings.form.fields.ipaLink.hint")}</Text>
              {ipa?.link && ipa.handle ? (
                <Text style={styles.derived} testID="collection-account-form-ipa_handle">
                  {t("app.collectionsSettings.form.fields.ipaLink.derived", { handle: `⁦${ipa.handle}⁩` })}
                </Text>
              ) : null}
              {!errors.ipa_link && draft.ipaText.trim() === "" ? (
                <Text style={styles.warn}>{t("app.collectionsSettings.form.fields.ipaLink.missingWarning")}</Text>
              ) : null}
              {err("ipa_link")}

              <Field
                testID="collection-account-form-account_last4"
                label={t("app.collectionsSettings.form.fields.accountLast4.label")}
                value={draft.accountLast4}
                onChangeText={(v) => set("accountLast4", v, "account_last4")}
                keyboardType="number-pad"
                maxLength={4}
                ltr
                editable={!busy}
              />
              <Text style={styles.hint}>{t("app.collectionsSettings.form.fields.accountLast4.hint")}</Text>
              {err("account_last4")}

              {draft.provider === "nbe" ? (
                <ToggleRow
                  testID="collection-account-form-is_prepaid_card"
                  label={t("app.collectionsSettings.form.fields.isPrepaidCard.label")}
                  hint={t("app.collectionsSettings.form.fields.isPrepaidCard.hint")}
                  value={draft.isPrepaidCard}
                  disabled={busy}
                  onValueChange={(v) => set("isPrepaidCard", v, "identity")}
                />
              ) : null}

              <Field
                testID="collection-account-form-iban"
                label={t("app.collectionsSettings.form.fields.iban.label")}
                value={draft.iban}
                onChangeText={(v) => set("iban", v, "iban")}
                placeholder="EG00 0000 0000 0000 0000 0000 0000 0"
                autoCapitalize="characters"
                autoCorrect={false}
                ltr
                editable={!busy}
              />
              {err("iban")}
              {err("identity")}
            </>
          ) : (
            <>
              <Field
                testID="collection-account-form-wallet_msisdn"
                label={t("app.collectionsSettings.form.fields.walletMsisdn.label")}
                value={draft.walletMsisdn}
                onChangeText={(v) => set("walletMsisdn", v, "wallet_msisdn")}
                placeholder="01XXXXXXXXX"
                keyboardType="phone-pad"
                ltr
                editable={!busy}
              />
              {err("wallet_msisdn")}

              <View testID="collection-account-form-wallet_opened_on" collapsable={false}>
                <DateField
                  label={t("app.collectionsSettings.form.fields.walletOpenedOn.label")}
                  value={draft.walletOpenedOn}
                  max={today}
                  disabled={busy}
                  onChange={(d) => set("walletOpenedOn", d, "wallet_opened_on")}
                />
              </View>
              <Text style={styles.hint}>{t("app.collectionsSettings.form.fields.walletOpenedOn.hint")}</Text>
              {err("wallet_opened_on")}
            </>
          )}

          <ToggleRow
            testID="collection-account-form-is_pos_default"
            label={t("app.collectionsSettings.form.fields.isPosDefault.label")}
            hint={t("app.collectionsSettings.form.fields.isPosDefault.hint")}
            value={draft.isPosDefault}
            disabled={busy}
            onValueChange={(v) => set("isPosDefault", v)}
          />

          {rail === "instapay" ? (
            <ToggleRow
              testID="collection-account-form-is_default_for_mobile"
              label={t("app.collectionsSettings.form.fields.isDefaultForMobile.label")}
              hint={t("app.collectionsSettings.form.fields.isDefaultForMobile.hint")}
              value={draft.isDefaultForMobile}
              disabled={busy}
              onValueChange={(v) => set("isDefaultForMobile", v)}
            />
          ) : null}
        </View>
      </Card>

      {access.ingest ? (
        <Card title={t("app.collectionsSettings.form.l2Heading")}>
          <View style={styles.form}>
            <ToggleRow
              testID="collection-account-form-auto_confirm_enabled"
              label={t("app.collectionsSettings.form.fields.autoConfirmEnabled.label")}
              hint={
                branchAutoConfirmOff
                  ? t("app.collectionsSettings.form.fields.autoConfirmEnabled.branchOff")
                  : t("app.collectionsSettings.form.fields.autoConfirmEnabled.hint")
              }
              value={draft.autoConfirmEnabled}
              disabled={busy}
              onValueChange={setAutoConfirm}
            />
            <Field
              testID="collection-account-form-review_threshold"
              label={t("app.collectionsSettings.form.fields.reviewThreshold.label")}
              value={draft.reviewThreshold}
              onChangeText={(v) => set("reviewThreshold", v, "review_threshold")}
              keyboardType="decimal-pad"
              ltr
              editable={!busy}
            />
            <Text style={styles.hint}>{t("app.collectionsSettings.form.fields.reviewThreshold.hint")}</Text>
            {err("review_threshold")}
            {rail === "wallet" ? (
              <ToggleRow
                testID="collection-account-form-balance_check_enabled"
                label={t("app.collectionsSettings.form.fields.balanceCheckEnabled.label")}
                hint={t("app.collectionsSettings.form.fields.balanceCheckEnabled.hint")}
                value={draft.balanceCheckEnabled}
                disabled={busy}
                onValueChange={(v) => set("balanceCheckEnabled", v)}
              />
            ) : null}
          </View>
        </Card>
      ) : null}

      <View style={styles.actions}>
        {/* Button takes no testID: the app's wrapper-View convention. */}
        <View testID="collection-account-save" collapsable={false}>
          <Button
            label={isNew ? t("app.collectionsSettings.form.create") : t("app.collectionsSettings.form.save")}
            onPress={submit}
            loading={save.isPending}
            disabled={busy || !online}
          />
        </View>
        {!isNew ? (
          <View testID="collection-account-archive" collapsable={false}>
            <Button
              label={t("app.collectionsSettings.form.archive")}
              variant="outline"
              onPress={confirmArchive}
              loading={archive.isPending}
              disabled={busy || !online}
              style={styles.archive}
            />
          </View>
        ) : null}
      </View>

      <ProviderSheet
        visible={providerOpen}
        rail={rail}
        value={draft.provider}
        onPick={(p) => {
          set("provider", p, "provider");
          if (p !== "nbe") set("isPrepaidCard", false);
        }}
        onClose={() => setProviderOpen(false)}
      />
    </>
  );
}

/** A labelled row that opens a picker sheet (provider). */
function PickerRow({
  label,
  value,
  placeholder = false,
  disabled = false,
  onPress,
  testID,
}: {
  label: string;
  value: string;
  placeholder?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <View style={styles.pickerWrap}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: value }}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.picker, pressed && styles.pickerPressed, disabled && styles.pickerDisabled]}
      >
        <Text numberOfLines={1} style={[styles.pickerValue, placeholder && styles.pickerPlaceholder]}>
          {value}
        </Text>
        {disabled ? null : <ChevronForward size={18} color={colors.textSecondary} />}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: -spacing.xs },
  derived: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 13, color: colors.successStrong },
  warn: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12, color: colors.warningStrong },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  noticeErr: { backgroundColor: colors.dangerLight, color: colors.danger },
  noticeWarn: { backgroundColor: colors.warningTint, color: colors.warningStrong },
  actions: { gap: spacing.sm },
  archive: { borderColor: colors.danger },
  pickerWrap: { gap: 8 },
  pickerLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  picker: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: Math.max(MIN_TOUCH, 52),
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  pickerPressed: { borderColor: colors.accent },
  pickerDisabled: { backgroundColor: colors.neutralTint },
  pickerValue: { ...RTL_TEXT, flex: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.text },
  pickerPlaceholder: { color: colors.textSecondary },
});
