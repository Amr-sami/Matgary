import { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { WhatsappLogoIcon as WhatsappLogo } from "phosphor-react-native/src/icons/WhatsappLogo";
import type { collections } from "@matgary/api-client";
import { isValidIpaLink } from "@matgary/domain/collections/ipa";

import {
  MAX_PARTS,
  addPart,
  cashRemainder,
  cleanLast4Input,
  enterSplit,
  formatWalletNumber,
  parseAmountInput,
  removePart,
  updatePart,
  type CartPaymentFields,
  type DigitalMethod,
  type TransferValidation,
} from "@/collections/checkout";
import type { AccountsState } from "@/collections/queries";
import { AccountPicker } from "@/components/collections/AccountPicker";
import { IpaQr } from "@/components/collections/IpaQr";
import { Field } from "@/components/ui/Field";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { money } from "@/lib/format";
import { toE164 } from "@/lib/customer-phone";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

type Account = collections.CollectionAccountDTO;

/**
 * The POS transfer panel (doc 15 spec 08 §4.2): which account receives the
 * money, what the customer is shown (the shop's InstaPay QR or wallet
 * number), optional payer hints, and the 1–4 part split with the remainder
 * in cash. Controlled: `value` is the cart's payment fields and every change
 * goes back through `onChange` (the cart store), so the live POST, the
 * outbox and offline Edit read one source.
 *
 * Copy rule (03 §A): record and confirm money received — never "accept
 * payments". The no-screenshot line is always on ([wallets.md §9]).
 */
export function TransferPanel({
  method,
  total,
  accounts,
  accountsState,
  loading = false,
  requireAccount,
  canManageAccounts,
  value,
  onChange,
  customerPhone,
  shopName,
  defaultAccountId,
  validation,
}: {
  method: DigitalMethod;
  total: number;
  /** accountsForMethod(method, …) — already filtered and ordered. */
  accounts: readonly Account[];
  accountsState: AccountsState;
  loading?: boolean;
  requireAccount: boolean;
  canManageAccounts: boolean;
  value: CartPaymentFields;
  onChange: (next: CartPaymentFields) => void;
  customerPhone: string;
  shopName: string;
  /** The rail's preselection, for a new part. */
  defaultAccountId: string | null;
  validation: TransferValidation;
}) {
  const split = value.collectionParts.length > 0;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const listed = accounts.length > 0;
  const unknown = accountsState === "unknown";

  // Account gone (branch switched, archived, feature off): clear picks that
  // are no longer listed (§4.2 item 10). Only when the list is KNOWN — an
  // unknown list says nothing about the pick.
  useEffect(() => {
    if (unknown) return;
    let next = value;
    if (next.collectionAccountId && !byId.has(next.collectionAccountId)) {
      next = { ...next, collectionAccountId: null };
    }
    if (next.collectionParts.some((p) => p.accountId && !byId.has(p.accountId))) {
      next = {
        ...next,
        collectionParts: next.collectionParts.map((p) =>
          p.accountId && !byId.has(p.accountId) ? { ...p, accountId: null } : p,
        ),
      };
    }
    if (next !== value) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknown, accounts, value.collectionAccountId, value.collectionParts]);

  // Amount inputs keep their own text while typing ("12." must survive);
  // the parsed number goes to the store on every keystroke.
  // Keyed by the parts count: adding or removing a part starts every input
  // from the store's number again (derived, no effect).
  const partsLen = value.collectionParts.length;
  const [draftState, setDraftState] = useState<{ len: number; map: Record<number, string> }>({ len: partsLen, map: {} });
  const drafts = draftState.len === partsLen ? draftState.map : {};
  const setDrafts = (f: (d: Record<number, string>) => Record<number, string>) =>
    setDraftState((st) => ({ len: partsLen, map: f(st.len === partsLen ? st.map : {}) }));

  const pickedSingle = value.collectionAccountId ? byId.get(value.collectionAccountId) ?? null : null;
  const shownAccounts: Account[] = split
    ? [...new Set(value.collectionParts.map((p) => p.accountId).filter((id): id is string => !!id))]
        .map((id) => byId.get(id))
        .filter((a): a is Account => !!a)
    : pickedSingle
      ? [pickedSingle]
      : [];
  const remainder = cashRemainder(total, value.collectionParts);
  const errors = new Set(validation.errors);
  const e164 = toE164(customerPhone);

  const share = (a: Account) => {
    if (!a.ipaLink || !e164) return;
    const text = t("app.collections.pos.shareText", { shop: shopName, link: a.ipaLink });
    void Linking.openURL(`https://wa.me/${e164.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`);
  };

  return (
    <View style={styles.panel} testID="pos-collection-panel" collapsable={false}>
      <Text style={styles.title}>{t("app.collections.pos.panelTitle")}</Text>

      {loading && !listed ? (
        <SkeletonListRow count={2} avatarSize={0} trailingWidth={0} height={48} />
      ) : unknown ? (
        <Text style={styles.hint}>{t("app.collections.pos.accountsUnknown")}</Text>
      ) : !listed ? (
        <View style={styles.gapSm}>
          <Text style={styles.hint}>{t("app.collections.pos.noAccounts")}</Text>
          {canManageAccounts ? <Text style={styles.hint}>{t("app.collections.pos.noAccountsOwnerHint")}</Text> : null}
        </View>
      ) : null}

      {listed && !split ? (
        <View style={styles.gapSm}>
          <Text style={styles.label}>{t("app.collections.pos.pickAccount")}</Text>
          <AccountPicker
            accounts={accounts}
            value={value.collectionAccountId}
            onChange={(id) => onChange({ ...value, collectionAccountId: id })}
            testIDPrefix="pos-collection-account-"
          />
          {errors.has("account_required") && requireAccount ? (
            <Text style={styles.error}>{t("app.collections.pos.accountRequired")}</Text>
          ) : null}
        </View>
      ) : null}
      {listed && accountsState === "cached" ? (
        <Text style={styles.hint}>{t("app.collections.pos.offlineAccounts")}</Text>
      ) : null}

      {/* What the customer is shown, per picked account. */}
      {shownAccounts.map((a) => (
        <CustomerFacing key={a.id} account={a} onShare={a.ipaLink && e164 && isValidIpaLink(a.ipaLink) ? () => share(a) : null} />
      ))}
      <Text style={styles.warn}>{t("app.collections.pos.noScreenshot")}</Text>

      {!split ? (
        <View style={styles.gapMd}>
          <Field
            label={t("app.collections.pos.payerLast4Label")}
            value={value.payerPhoneLast4}
            onChangeText={(v) => onChange({ ...value, payerPhoneLast4: cleanLast4Input(v) })}
            keyboardType="number-pad"
            maxLength={4}
            ltr
            testID="pos-collection-payer"
          />
          {errors.has("payer_last4_invalid") ? (
            <Text style={styles.error}>{t("app.collections.pos.payerLast4Invalid")}</Text>
          ) : null}
          <Field
            label={t("app.collections.pos.referenceLabel")}
            value={value.payerReference}
            onChangeText={(v) => onChange({ ...value, payerReference: v })}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={16}
            ltr
            placeholder={t("app.collections.pos.referenceHint")}
            testID="pos-collection-ref"
          />
          {errors.has("reference_invalid") ? (
            <Text style={styles.error}>{t("app.collections.pos.referenceInvalid")}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.gapMd}>
          {value.collectionParts.map((p, i) => {
            const n = i + 1;
            const prefix = `pos-collection-part-${n}`;
            const draft = drafts[i];
            return (
              <View key={i} style={styles.part} testID={prefix} collapsable={false}>
                <View style={styles.partHead}>
                  <Text style={styles.partTitle}>{t("app.collections.pos.partTitle", { n })}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("app.collections.pos.removePart")}
                    hitSlop={8}
                    onPress={() => onChange(removePart(value, i, total))}
                    style={styles.remove}
                    testID={`${prefix}-remove`}
                  >
                    <Trash size={18} color={colors.textSecondary} />
                  </Pressable>
                </View>
                <AccountPicker
                  accounts={accounts}
                  value={p.accountId}
                  onChange={(id) => onChange(updatePart(value, i, { accountId: id }))}
                  testIDPrefix={`${prefix}-account-`}
                />
                <Field
                  label={t("app.collections.pos.partAmount")}
                  value={draft ?? (p.amount > 0 ? String(p.amount) : "")}
                  onChangeText={(v) => {
                    setDrafts((d) => ({ ...d, [i]: v }));
                    onChange(updatePart(value, i, { amount: parseAmountInput(v) }));
                  }}
                  onBlur={() =>
                    setDrafts((d) => {
                      const { [i]: _drop, ...rest } = d;
                      return rest;
                    })
                  }
                  keyboardType="decimal-pad"
                  ltr
                  adornment={t("app.inventory.addProduct.step3.fields.currencySuffix")}
                  testID={`${prefix}-amount`}
                />
                <Field
                  label={t("app.collections.pos.payerLast4Label")}
                  value={p.payerPhoneLast4}
                  onChangeText={(v) => onChange(updatePart(value, i, { payerPhoneLast4: cleanLast4Input(v) }))}
                  keyboardType="number-pad"
                  maxLength={4}
                  ltr
                  testID={`${prefix}-payer`}
                />
                <Field
                  label={t("app.collections.pos.referenceLabel")}
                  value={p.payerReference}
                  onChangeText={(v) => onChange(updatePart(value, i, { payerReference: v }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={16}
                  ltr
                  testID={`${prefix}-ref`}
                />
              </View>
            );
          })}
          <View style={styles.remainderRow} testID="pos-collection-cash-remainder" collapsable={false}>
            <Text style={[styles.remainder, remainder < 0 && styles.remainderBad]}>
              {t("app.collections.pos.cashRemainder", { amount: money(Math.max(0, remainder)) })}
            </Text>
          </View>
          {errors.has("account_required") ? <Text style={styles.error}>{t("app.collections.pos.accountRequired")}</Text> : null}
          {errors.has("part_amount_invalid") ? <Text style={styles.error}>{t("app.collections.pos.partAmountInvalid")}</Text> : null}
          {errors.has("parts_exceed_total") ? <Text style={styles.error}>{t("app.collections.pos.partsExceedTotal")}</Text> : null}
          {errors.has("too_many_parts") ? <Text style={styles.error}>{t("app.collections.pos.maxParts")}</Text> : null}
          {errors.has("payer_last4_invalid") ? <Text style={styles.error}>{t("app.collections.pos.payerLast4Invalid")}</Text> : null}
          {errors.has("reference_invalid") ? <Text style={styles.error}>{t("app.collections.pos.referenceInvalid")}</Text> : null}
        </View>
      )}

      {validation.warnings.includes("instapay_over_limit") ? (
        <Text style={styles.warn}>{t("app.collections.pos.instapayOverLimit")}</Text>
      ) : null}

      {/* Split (Q5): only with ≥ 1 account listed — every part names one (03 §B.17). */}
      {listed ? (
        <View style={styles.splitRow}>
          {!split ? (
            <SplitButton
              label={t("app.collections.pos.split")}
              testID="pos-collection-split"
              onPress={() => onChange(enterSplit(value, total))}
            />
          ) : null}
          {value.collectionParts.length < MAX_PARTS ? (
            <SplitButton
              label={t("app.collections.pos.addPart")}
              testID="pos-collection-add-part"
              icon
              onPress={() => onChange(addPart(value, total, defaultAccountId))}
            />
          ) : (
            <Text style={styles.hint}>{t("app.collections.pos.maxParts")}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The picked account as the customer must see it: QR, wallet number, name to check. */
function CustomerFacing({ account, onShare }: { account: Account; onShare: (() => void) | null }) {
  const qr = account.ipaLink && isValidIpaLink(account.ipaLink);
  return (
    <View style={styles.facing}>
      {qr ? (
        <>
          <IpaQr link={account.ipaLink!} />
          {account.ipaHandle ? <Text style={styles.handle}>{`⁦${account.ipaHandle}⁩`}</Text> : null}
          <Text style={styles.centerHint}>{t("app.collections.pos.scanHint")}</Text>
        </>
      ) : account.rail === "wallet" && account.walletMsisdn ? (
        <>
          <Text style={styles.number} testID="pos-collection-number" selectable>
            {`⁦${formatWalletNumber(account.walletMsisdn)}⁩`}
          </Text>
          <Text style={styles.centerHint}>{t("app.collections.pos.sendToNumber")}</Text>
        </>
      ) : account.ipaHandle ? (
        <Text style={styles.handle}>{`⁦${account.ipaHandle}⁩`}</Text>
      ) : null}
      {account.holderName ? (
        <Text style={styles.centerHint}>{t("app.collections.pos.checkName", { name: account.holderName })}</Text>
      ) : null}
      {onShare ? (
        <Pressable
          accessibilityRole="button"
          onPress={onShare}
          style={styles.share}
          testID="pos-collection-share"
        >
          <WhatsappLogo size={18} color={colors.successStrong} />
          <Text style={styles.shareText}>{t("app.collections.pos.share")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SplitButton({ label, testID, onPress, icon }: { label: string; testID: string; onPress: () => void; icon?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.splitBtn, pressed && styles.splitBtnPressed]}
    >
      {icon ? <Plus size={16} color={colors.accent} weight="bold" /> : null}
      <Text numberOfLines={1} style={styles.splitText}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  title: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  warn: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.warningStrong },
  error: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
  gapSm: { gap: spacing.sm },
  gapMd: { gap: spacing.md },
  facing: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
  },
  handle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, textAlign: "center", writingDirection: "ltr" },
  number: {
    fontFamily: fonts.bold,
    fontSize: 28,
    letterSpacing: 1,
    color: colors.text,
    textAlign: "center",
    writingDirection: "ltr",
    fontVariant: ["tabular-nums"],
  },
  centerHint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, textAlign: "center", paddingHorizontal: spacing.md },
  share: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
  },
  shareText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.successStrong },
  part: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  partHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  partTitle: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  remove: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  remainderRow: { paddingVertical: spacing.xs },
  remainder: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  remainderBad: { color: colors.danger },
  splitRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  splitBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    flexShrink: 0,
  },
  splitBtnPressed: { backgroundColor: colors.accentLight },
  splitText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
});
