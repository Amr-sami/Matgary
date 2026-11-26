/**
 * Digital collections — the receiving-account form's pure rules (doc 15 spec
 * 09 §4.4–§4.5; 03 §B.2.1 columns, §B.17 camelCase wire body).
 *
 * TYPE-ONLY imports on purpose: `node --test --experimental-strip-types`
 * loads this file directly (see __tests__/account-form.test.ts), the same way
 * lib/customer-phone.ts is tested. The validators that the server also runs
 * are INJECTED (`AccountRules`) from spec 06's `packages/domain` so the phone,
 * the web (12) and the server zod (05) share one implementation:
 *
 *   isValidIpaLink / ipaHandleFromLink / ipaLinkFromShareText
 *                     → @matgary/domain/collections/ipa
 *   normalizeIban / normalizeWalletMsisdn
 *                     → @matgary/domain/collections/normalize
 *
 * 09 §4.5 "Reconciliation with spec 06": once 06 part A landed, the local
 * `isValidEgIban` was dropped for 06's `normalizeIban` (format + ISO 13616
 * mod-97), and the wallet rule uses 06's `normalizeWalletMsisdn` (the exact
 * function behind the server's 400 INVALID_WALLET_NUMBER) instead of
 * `toE164` + a regex. `extractIpaLink` keeps its name here but delegates to
 * 06's `ipaLinkFromShareText`, so there is one link extractor (phishing risk
 * IF7: look-alike hosts, http, trailing junk) for every client.
 *
 * Wire rules (05's zod, `apps/web/lib/collections/schemas.ts`, wins over 09
 * §4.4 where they differ — 09 §4.4 "05 wins: change only toBody()"):
 *  - create: every field; the other rail's fields are sent as `null`;
 *  - edit (PATCH): changed fields only; never `rail` or `provider` (05's
 *    PATCH schema is strict and has neither — a different bank is a new
 *    account), never the other rail's fields;
 *  - L2 fields (`autoConfirmEnabled`, `reviewThreshold`,
 *    `balanceCheckEnabled`) only while `features.collectionsIngest`.
 */
import type { collections } from "@matgary/api-client";

export type Rail = collections.CollectionRail;
type CollectionAccountDTO = collections.CollectionAccountDTO;

/** 06's validators, injected (see the module comment). */
export interface AccountRules {
  isValidIpaLink(link: string): boolean;
  ipaHandleFromLink(link: string): string | null;
  /** 06 `ipaLinkFromShareText`: the first valid link in a pasted share text. */
  ipaLinkFromShareText(text: string): string | null;
  /** 06 `normalizeIban`: compact `^EG\d{27}$` with mod-97 = 1, or null. */
  normalizeIban(raw: string): string | null;
  /** 06 `normalizeWalletMsisdn`: `+201[0125]XXXXXXXX`, or null. */
  normalizeWalletMsisdn(raw: string): string | null;
}

/** The provider ids of one rail, from 06's COLLECTION_PROVIDERS (injected by the screen). */
export type ProviderRails = Readonly<Record<string, { rail: Rail }>>;

export interface AccountDraft {
  rail: Rail;
  /** "" until picked. */
  provider: string;
  label: string;
  holderName: string;
  /** The pasted InstaPay share text, or the stored link when editing. */
  ipaText: string;
  /** The stored handle (an account created with a handle and no link). */
  ipaHandle: string | null;
  accountLast4: string;
  isPrepaidCard: boolean;
  iban: string;
  walletMsisdn: string;
  walletOpenedOn: string | null;
  /** null = every branch. */
  branchId: string | null;
  isPosDefault: boolean;
  isDefaultForMobile: boolean;
  autoConfirmEnabled: boolean;
  reviewThreshold: string;
  balanceCheckEnabled: boolean;
}

/**
 * The 03 §B.2.1 column an error sits under — also the testID suffix of the
 * field (`collection-account-form-<column>`). `identity` is the form-level
 * rule mirroring `collection_accounts_identity_chk`.
 */
export type AccountColumn =
  | "provider"
  | "label"
  | "holder_name"
  | "ipa_link"
  | "account_last4"
  | "iban"
  | "wallet_msisdn"
  | "wallet_opened_on"
  | "review_threshold"
  | "identity";

/** Key suffixes under `app.collectionsSettings.form.`. */
export type AccountFormError =
  | "providerRequired"
  | "labelRequired"
  | "labelTooLong"
  | "holderNameTooLong"
  | "identityRequired"
  | "fields.ipaLink.invalid"
  | "fields.accountLast4.invalid"
  | "fields.iban.invalid"
  | "fields.iban.checksum"
  | "fields.walletMsisdn.invalid"
  | "fields.walletOpenedOn.invalid"
  | "fields.reviewThreshold.invalid";

export type AccountErrors = Partial<Record<AccountColumn, AccountFormError>>;

export type ValidationResult =
  | { ok: true; body: Record<string, unknown>; warnings: "ipaLinkMissing"[] }
  | { ok: false; errors: AccountErrors };

export interface ValidateOptions {
  /** `features.collectionsIngest`: the L2 section is shown and sent. */
  includeL2: boolean;
  /** "YYYY-MM-DD" in the device's local time. */
  today: string;
  /** Provider → rail (06 COLLECTION_PROVIDERS). Omitted = any non-empty id passes. */
  providers?: ProviderRails;
}

export const LABEL_MAX = 60;
export const HOLDER_NAME_MAX = 80;

/** ٠-٩ (U+0660) and ۰-۹ (U+06F0) → 0-9; everything else untouched. */
export function asciiDigits(s: string): string {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/**
 * The InstaPay link in what the owner pasted: the whole text when it is a
 * link, else the first valid `https://ipn.eg/S/<handle>/instapay/<id>` in it
 * (06 `ipaLinkFromShareText`), else null.
 */
export function extractIpaLink(
  text: string,
  rules: Pick<AccountRules, "isValidIpaLink" | "ipaLinkFromShareText">,
): string | null {
  const s = String(text ?? "").trim();
  if (s === "") return null;
  if (rules.isValidIpaLink(s)) return s;
  const found = rules.ipaLinkFromShareText(s);
  return found && rules.isValidIpaLink(found) ? found : null;
}

/** What the draft's InstaPay text resolves to ("" text keeps the stored handle). */
export function ipaFromDraft(
  d: Pick<AccountDraft, "ipaText" | "ipaHandle">,
  rules: Pick<AccountRules, "isValidIpaLink" | "ipaHandleFromLink" | "ipaLinkFromShareText">,
): { link: string | null; handle: string | null; invalid: boolean } {
  const text = String(d.ipaText ?? "").trim();
  if (text === "") return { link: null, handle: d.ipaHandle, invalid: false };
  const link = extractIpaLink(text, rules);
  if (!link) return { link: null, handle: null, invalid: true };
  const handle = rules.ipaHandleFromLink(link);
  // 05 derives the handle from the link and answers 400 when it cannot: a
  // link whose segment is no valid handle is not accepted here either.
  if (!handle) return { link: null, handle: null, invalid: true };
  return { link, handle, invalid: false };
}

/** A new, empty draft for `rail` (the branch defaults to the active one, like the web). */
export function emptyDraft(rail: Rail, branchId: string | null): AccountDraft {
  return {
    rail,
    provider: "",
    label: "",
    holderName: "",
    ipaText: "",
    ipaHandle: null,
    accountLast4: "",
    isPrepaidCard: false,
    iban: "",
    walletMsisdn: "",
    walletOpenedOn: null,
    branchId,
    isPosDefault: false,
    isDefaultForMobile: false,
    autoConfirmEnabled: false,
    reviewThreshold: "",
    balanceCheckEnabled: true,
  };
}

/** The fields of a CollectionAccountDTO the form reads. */
export type CollectionAccountLike = Pick<
  CollectionAccountDTO,
  | "rail"
  | "provider"
  | "label"
  | "holderName"
  | "ipaHandle"
  | "ipaLink"
  | "accountLast4"
  | "isPrepaidCard"
  | "iban"
  | "walletMsisdn"
  | "walletOpenedOn"
  | "branchId"
  | "isPosDefault"
  | "isDefaultForMobile"
  | "autoConfirmEnabled"
  | "reviewThreshold"
  | "balanceCheckEnabled"
>;

/** "+201012345678" → "01012345678" (what the owner typed); anything else unchanged. */
export function nationalWalletNumber(msisdn: string | null | undefined): string {
  if (!msisdn) return "";
  const m = /^\+20(1\d{9})$/.exec(msisdn);
  return m ? `0${m[1]}` : msisdn;
}

export function draftFromDto(dto: CollectionAccountLike): AccountDraft {
  return {
    rail: dto.rail,
    provider: dto.provider,
    label: dto.label,
    holderName: dto.holderName ?? "",
    ipaText: dto.ipaLink ?? "",
    ipaHandle: dto.ipaHandle ?? null,
    accountLast4: dto.accountLast4 ?? "",
    isPrepaidCard: dto.isPrepaidCard,
    iban: dto.iban ?? "",
    walletMsisdn: nationalWalletNumber(dto.walletMsisdn),
    walletOpenedOn: dto.walletOpenedOn ?? null,
    branchId: dto.branchId,
    isPosDefault: dto.isPosDefault,
    isDefaultForMobile: dto.isDefaultForMobile,
    autoConfirmEnabled: dto.autoConfirmEnabled,
    reviewThreshold: dto.reviewThreshold != null ? String(dto.reviewThreshold) : "",
    balanceCheckEnabled: dto.balanceCheckEnabled,
  };
}

const EG_IBAN_SHAPE = /^EG\d{27}$/;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Digits with optional "," thousands groups, ≤ 2 decimals, never negative. */
const THRESHOLD_RE = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

function validYmd(s: string): boolean {
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

/** 03 §B.2.4 `collections_stale_after_minutes` CHECK 15..1440 (Q15). */
export const STALE_MINUTES_MIN = 15;
export const STALE_MINUTES_MAX = 1440;

/**
 * The hub's stale-minutes field (09 §4.3 item 3): an integer 15–1440
 * (Arabic-Indic digits allowed), else null — and a null never reaches the
 * server (09 §6 criterion 3).
 */
export function staleMinutesFrom(text: string): number | null {
  const v = asciiDigits(text).trim();
  if (!/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n >= STALE_MINUTES_MIN && n <= STALE_MINUTES_MAX ? n : null;
}

/** "٥٬٠٠٠" / "5,000.5" → 5000 / 5000.5; null when not a valid threshold. */
export function parseThreshold(raw: string): number | null {
  const v = asciiDigits(raw).replace(/٬/g, ",").replace(/٫/g, ".").replace(/\s+/g, "");
  if (!THRESHOLD_RE.test(v)) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 09 §4.4 rules. Returns the full camelCase wire body of a CREATE (the other
 * rail's fields as `null`, L2 fields only with `includeL2`), or the errors
 * keyed by column.
 */
export function validateAccountDraft(d: AccountDraft, rules: AccountRules, opts: ValidateOptions): ValidationResult {
  const errors: AccountErrors = {};
  const warnings: "ipaLinkMissing"[] = [];

  const provider = String(d.provider ?? "").trim();
  const providerRail = provider && opts.providers ? opts.providers[provider]?.rail : undefined;
  if (!provider || (opts.providers && providerRail !== d.rail)) errors.provider = "providerRequired";

  const label = String(d.label ?? "").trim();
  if (label.length === 0) errors.label = "labelRequired";
  else if (label.length > LABEL_MAX) errors.label = "labelTooLong";
  const holder = String(d.holderName ?? "").trim();
  if (holder.length > HOLDER_NAME_MAX) errors.holder_name = "holderNameTooLong";

  let ipaLink: string | null = null;
  let ipaHandle: string | null = null;
  let accountLast4: string | null = null;
  let iban: string | null = null;
  let isPrepaidCard = false;
  let walletMsisdn: string | null = null;
  let walletOpenedOn: string | null = null;

  if (d.rail === "instapay") {
    const ipa = ipaFromDraft(d, rules);
    if (ipa.invalid) errors.ipa_link = "fields.ipaLink.invalid";
    ipaLink = ipa.link;
    ipaHandle = ipa.handle;

    const l4 = asciiDigits(d.accountLast4).trim();
    if (l4 !== "") {
      if (/^\d{4}$/.test(l4)) accountLast4 = l4;
      else errors.account_last4 = "fields.accountLast4.invalid";
    }

    const rawIban = asciiDigits(d.iban).replace(/\s+/g, "").toUpperCase();
    if (rawIban !== "") {
      if (!EG_IBAN_SHAPE.test(rawIban)) errors.iban = "fields.iban.invalid";
      else {
        iban = rules.normalizeIban(rawIban);
        if (iban == null) errors.iban = "fields.iban.checksum";
      }
    }

    // NBE prepaid cards only (their credit SMS carries no digits, IP-NBE-2).
    isPrepaidCard = provider === "nbe" ? Boolean(d.isPrepaidCard) : false;

    const hasIdentity = ipaLink != null || ipaHandle != null || accountLast4 != null || iban != null || isPrepaidCard;
    if (!hasIdentity && !errors.ipa_link && !errors.account_last4 && !errors.iban) {
      errors.identity = "identityRequired";
    }
    if (!ipa.invalid && ipaLink == null && hasIdentity) warnings.push("ipaLinkMissing");
  } else {
    walletMsisdn = rules.normalizeWalletMsisdn(asciiDigits(d.walletMsisdn));
    if (walletMsisdn == null) errors.wallet_msisdn = "fields.walletMsisdn.invalid";
    const opened = String(d.walletOpenedOn ?? "").trim();
    if (opened !== "") {
      if (!validYmd(opened) || opened > opts.today) errors.wallet_opened_on = "fields.walletOpenedOn.invalid";
      else walletOpenedOn = opened;
    }
  }

  let reviewThreshold: number | null = null;
  if (opts.includeL2 && String(d.reviewThreshold ?? "").trim() !== "") {
    reviewThreshold = parseThreshold(d.reviewThreshold);
    if (reviewThreshold == null) errors.review_threshold = "fields.reviewThreshold.invalid";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const instapay = d.rail === "instapay";
  const body: Record<string, unknown> = {
    rail: d.rail,
    provider,
    label,
    holderName: holder === "" ? null : holder,
    ipaHandle: instapay ? ipaHandle : null,
    ipaLink: instapay ? ipaLink : null,
    accountLast4: instapay ? accountLast4 : null,
    isPrepaidCard: instapay ? isPrepaidCard : null,
    iban: instapay ? iban : null,
    walletMsisdn: instapay ? null : walletMsisdn,
    walletOpenedOn: instapay ? null : walletOpenedOn,
    branchId: d.branchId,
    isPosDefault: Boolean(d.isPosDefault),
    isDefaultForMobile: instapay ? Boolean(d.isDefaultForMobile) : null,
  };
  if (opts.includeL2) {
    body.autoConfirmEnabled = Boolean(d.autoConfirmEnabled);
    if (reviewThreshold != null) body.reviewThreshold = reviewThreshold;
    if (!instapay) body.balanceCheckEnabled = Boolean(d.balanceCheckEnabled);
  }
  return { ok: true, body, warnings };
}

/** The keys of `after` whose value differs from `before` (JSON equality; undefined = null). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = v;
  }
  return out;
}

const INSTAPAY_ONLY = ["ipaHandle", "ipaLink", "accountLast4", "isPrepaidCard", "iban", "isDefaultForMobile"] as const;
const WALLET_ONLY = ["walletMsisdn", "walletOpenedOn", "balanceCheckEnabled"] as const;

/**
 * The PATCH body of an edit: the fields that changed between the draft the
 * screen opened with and the current one — never `rail` / `provider`, never
 * the other rail's fields. `{ok: true, body: {}}` = nothing to send.
 */
export function patchBody(
  before: AccountDraft,
  after: AccountDraft,
  rules: AccountRules,
  opts: ValidateOptions,
): ValidationResult {
  const a = validateAccountDraft(after, rules, opts);
  if (!a.ok) return a;
  // The stored draft is what the server holds, so it normally validates; if
  // it does not (a legacy row), every field of `after` counts as changed.
  const b = validateAccountDraft(before, rules, { ...opts, providers: undefined });
  const diff = changedFields(b.ok ? b.body : {}, a.body);
  delete diff.rail;
  delete diff.provider;
  for (const k of after.rail === "instapay" ? WALLET_ONLY : INSTAPAY_ONLY) delete diff[k];
  return { ok: true, body: diff, warnings: a.warnings };
}
