/**
 * Digital collections — the POS transfer panel's pure logic (doc 15 spec 08
 * §4.1–§4.4).
 *
 * TYPE-ONLY imports on purpose: plain `node --test --experimental-strip-types`
 * loads this file the same way lib/customer-phone.ts is tested. The cart
 * store (stores/cart.ts) cannot be loaded by Node (zustand + expo modules),
 * so every rule the store, the panel, the live POST and the offline outbox
 * share lives here.
 *
 * Money is compared in integer piasters (`Math.round(x * 100)`), like the
 * domain matcher (03 §B.2), so 0.1 + 0.2 is 0.3 and not 0.30000000000000004.
 *
 * Wire rule (03 §B.17, the server's zod in app/api/sales/cart/route.ts): a
 * `collectionParts` item always carries a uuid `accountId`. So a split needs
 * an account on every part (validateTransfer says `account_required`), and
 * the panel only offers split when at least one account is listed. 08 §4.3
 * "accountId omitted when null" would be a terminal 400; 03 wins.
 */
import type { collections, sales } from "@matgary/api-client";

type PaymentMethod = sales.PaymentMethod;
type CartOptions = sales.CartOptions;
type CollectionAccountDTO = collections.CollectionAccountDTO;
export type DigitalMethod = collections.DigitalMethod;

/** The fields accountsForMethod / accountIdentity read — a DTO is a superset. */
export type AccountLike = Pick<
  CollectionAccountDTO,
  | "id"
  | "branchId"
  | "rail"
  | "provider"
  | "label"
  | "ipaHandle"
  | "ipaLink"
  | "accountLast4"
  | "walletMsisdn"
  | "isPosDefault"
  | "sortOrder"
  | "archivedAt"
  | "mask"
>;

export interface CollectionPartDraft {
  accountId: string | null;
  /** EGP, 2 decimals; 0 = not typed yet. */
  amount: number;
  /** "" = none. */
  payerPhoneLast4: string;
  /** "" = none. */
  payerReference: string;
}

export interface CartPaymentFields {
  /** "cash" after every reset(). */
  paymentMethod: PaymentMethod;
  /** Single-transfer mode. */
  collectionAccountId: string | null;
  payerPhoneLast4: string;
  payerReference: string;
  /** [] = one transfer of the whole total (single mode). */
  collectionParts: CollectionPartDraft[];
}

export const DIGITAL_METHODS = ["instapay", "wallet"] as const satisfies readonly DigitalMethod[];

/** 03 §C.6 / Q5: 1–4 transfer parts per sale, the rest cash. */
export const MAX_PARTS = 4;

/**
 * InstaPay's per-transaction ceiling, EGP 70,000 ([instapay.md §3],
 * https://www.instapay.eg/?lang=en). A warning only: the shop can still ring it.
 */
export const INSTAPAY_MAX_PER_TRANSFER = 70000;

const LAST4_RE = /^\d{4}$/;
const REFERENCE_RE = /^[0-9A-Za-z]{4,16}$/;

export function isDigitalMethod(m: PaymentMethod | null | undefined): m is DigitalMethod {
  return m === "instapay" || m === "wallet";
}

/**
 * POS chips in order. Feature off (or an older server): exactly today's four.
 * On: `wallet` sits between `instapay` and `card` (08 §4.2).
 */
export function posPaymentMethods(collectionsOn: boolean): PaymentMethod[] {
  return collectionsOn
    ? ["cash", "instapay", "wallet", "card", "deferred"]
    : ["cash", "instapay", "card", "deferred"];
}

export function emptyPayment(): CartPaymentFields {
  return {
    paymentMethod: "cash",
    collectionAccountId: null,
    payerPhoneLast4: "",
    payerReference: "",
    collectionParts: [],
  };
}

/** Integer piasters. */
export function toPiasters(egp: number): number {
  return Number.isFinite(egp) ? Math.round(egp * 100) : 0;
}

function fromPiasters(p: number): number {
  return p / 100;
}

/** R12: cashiers type references with spaces or dashes; strip before checking/sending. */
export function normalizeReference(s: string): string {
  return (s ?? "").replace(/[\s-]/g, "");
}

function normalizeLast4(s: string): string {
  return (s ?? "").trim();
}

function byPosOrder(a: AccountLike, b: AccountLike): number {
  if (a.isPosDefault !== b.isPosDefault) return a.isPosDefault ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  // No Intl on Hermes; a plain code-unit order is stable and good enough.
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/**
 * Accounts the picker lists for `method` (08 §4.2 item 1):
 *  - archived rows and rows of another branch are dropped (a branch-less row
 *    serves every branch; an unknown active branch keeps everything, the
 *    server already scoped the list);
 *  - `wallet` → wallet-rail accounts only (03 §C.1);
 *  - `instapay` → every digital account, InstaPay rail first, then wallets
 *    (InstaPay can pay a wallet, [wallets.md key fact 15]);
 *  - within a rail: POS default first, then sortOrder, then label.
 */
export function accountsForMethod<A extends AccountLike>(
  method: PaymentMethod | null | undefined,
  accounts: readonly A[] | null | undefined,
  branchId: string | null | undefined,
): A[] {
  if (!isDigitalMethod(method) || !accounts) return [];
  const live = accounts.filter(
    (a) => a.archivedAt == null && (a.branchId == null || branchId == null || a.branchId === branchId),
  );
  if (method === "wallet") return live.filter((a) => a.rail === "wallet").sort(byPosOrder);
  return [
    ...live.filter((a) => a.rail === "instapay").sort(byPosOrder),
    ...live.filter((a) => a.rail === "wallet").sort(byPosOrder),
  ];
}

/**
 * Preselection when the cashier taps a digital chip (08 §4.2 item 2): the POS
 * default of the method's rail; else the only listed account; else nothing.
 */
export function defaultAccountFor(
  method: PaymentMethod | null | undefined,
  accounts: readonly AccountLike[] | null | undefined,
  branchId: string | null | undefined,
): string | null {
  if (!isDigitalMethod(method)) return null;
  const listed = accountsForMethod(method, accounts, branchId);
  const posDefault = listed.find((a) => a.rail === method && a.isPosDefault);
  if (posDefault) return posDefault.id;
  return listed.length === 1 ? listed[0]!.id : null;
}

// ─── split (Q5) ──────────────────────────────────────────────────────────────

export function isSplit(fields: CartPaymentFields): boolean {
  return fields.collectionParts.length > 0;
}

/** Σ part amounts in EGP (summed in piasters). */
export function partsTotal(parts: readonly Pick<CollectionPartDraft, "amount">[]): number {
  return fromPiasters(parts.reduce((s, p) => s + toPiasters(p.amount), 0));
}

/** total − Σparts in EGP (piasters inside). Negative when the parts exceed the total. */
export function cashRemainder(total: number, parts: readonly Pick<CollectionPartDraft, "amount">[]): number {
  return fromPiasters(toPiasters(total) - parts.reduce((s, p) => s + toPiasters(p.amount), 0));
}

/**
 * Enter parts mode: part 1 takes the single-mode account and payer hints and
 * the whole total; the single fields are cleared (they live in the part now).
 */
export function enterSplit(fields: CartPaymentFields, total: number): CartPaymentFields {
  if (isSplit(fields)) return fields;
  return {
    ...fields,
    collectionAccountId: null,
    payerPhoneLast4: "",
    payerReference: "",
    collectionParts: [
      {
        accountId: fields.collectionAccountId,
        amount: fromPiasters(Math.max(0, toPiasters(total))),
        payerPhoneLast4: fields.payerPhoneLast4,
        payerReference: fields.payerReference,
      },
    ],
  };
}

/**
 * Append a part with what is left of the total (never negative), on the
 * default account. From single mode it enters split first. Stops at MAX_PARTS.
 */
export function addPart(
  fields: CartPaymentFields,
  total: number,
  defaultAccountId: string | null,
): CartPaymentFields {
  const base = enterSplit(fields, total);
  if (base.collectionParts.length >= MAX_PARTS) return base;
  const left = Math.max(0, toPiasters(total) - base.collectionParts.reduce((s, p) => s + toPiasters(p.amount), 0));
  return {
    ...base,
    collectionParts: [
      ...base.collectionParts,
      { accountId: defaultAccountId, amount: fromPiasters(left), payerPhoneLast4: "", payerReference: "" },
    ],
  };
}

/**
 * Collapse to single mode when one part is left and it carries the whole
 * total (or no part is left at all).
 */
function collapseIfWhole(fields: CartPaymentFields, total: number): CartPaymentFields {
  const parts = fields.collectionParts;
  if (parts.length === 0) return { ...fields, collectionParts: [] };
  if (parts.length === 1 && toPiasters(parts[0]!.amount) === toPiasters(total)) {
    const only = parts[0]!;
    return {
      ...fields,
      collectionAccountId: only.accountId,
      payerPhoneLast4: only.payerPhoneLast4,
      payerReference: only.payerReference,
      collectionParts: [],
    };
  }
  return fields;
}

/** Remove part `index` (0-based); back to single mode per collapseIfWhole. */
export function removePart(fields: CartPaymentFields, index: number, total: number): CartPaymentFields {
  if (index < 0 || index >= fields.collectionParts.length) return fields;
  return collapseIfWhole(
    { ...fields, collectionParts: fields.collectionParts.filter((_, i) => i !== index) },
    total,
  );
}

export function updatePart(
  fields: CartPaymentFields,
  index: number,
  patch: Partial<CollectionPartDraft>,
): CartPaymentFields {
  if (index < 0 || index >= fields.collectionParts.length) return fields;
  return {
    ...fields,
    collectionParts: fields.collectionParts.map((p, i) => (i === index ? { ...p, ...patch } : p)),
  };
}

// ─── validation (08 §4.4) ────────────────────────────────────────────────────

export type TransferErrorCode =
  | "account_required"
  | "part_amount_invalid"
  | "parts_exceed_total"
  | "too_many_parts"
  | "payer_last4_invalid"
  | "reference_invalid";

export type TransferWarningCode = "instapay_over_limit";

export interface TransferValidationContext {
  /** The cart total the POST books (after the order discount). */
  total: number;
  /** features.collections */
  collectionsOn: boolean;
  /** settings.collectionsRequireAccount; null/undefined = settings unknown → true (the server default). */
  requireAccount: boolean | null | undefined;
  /**
   * The accounts listed for the method (accountsForMethod), or null when they
   * are UNKNOWN (offline and never cached, or the query failed): then no pick
   * is required (08 §4.2 item 8).
   */
  accounts: readonly Pick<AccountLike, "id">[] | null;
}

export interface TransferValidation {
  ok: boolean;
  errors: TransferErrorCode[];
  warnings: TransferWarningCode[];
}

/**
 * Blocks the record button only for errors; warnings are shown and ignored
 * (08 §4.4). Codes are emitted once each, in the table's order.
 */
export function validateTransfer(fields: CartPaymentFields, ctx: TransferValidationContext): TransferValidation {
  const errors = new Set<TransferErrorCode>();
  const warnings = new Set<TransferWarningCode>();
  if (!ctx.collectionsOn || !isDigitalMethod(fields.paymentMethod)) {
    return { ok: true, errors: [], warnings: [] };
  }
  const listed = ctx.accounts;
  const knownIds = listed ? new Set(listed.map((a) => a.id)) : null;
  const hasAccount = (id: string | null) => id != null && (knownIds === null || knownIds.has(id));
  const requireAccount = ctx.requireAccount ?? true;
  const parts = fields.collectionParts;

  if (parts.length > 0) {
    // The wire needs an account on every part (03 §B.17), whatever the
    // branch switch says.
    if (parts.some((p) => !hasAccount(p.accountId))) errors.add("account_required");
    if (parts.some((p) => !(Number.isFinite(p.amount) && toPiasters(p.amount) > 0))) errors.add("part_amount_invalid");
    if (parts.reduce((s, p) => s + toPiasters(p.amount), 0) > toPiasters(ctx.total)) errors.add("parts_exceed_total");
    if (parts.length > MAX_PARTS) errors.add("too_many_parts");
    for (const p of parts) {
      const l4 = normalizeLast4(p.payerPhoneLast4);
      if (l4 && !LAST4_RE.test(l4)) errors.add("payer_last4_invalid");
      const ref = normalizeReference(p.payerReference);
      if (ref && !REFERENCE_RE.test(ref)) errors.add("reference_invalid");
      if (fields.paymentMethod === "instapay" && p.amount > INSTAPAY_MAX_PER_TRANSFER) warnings.add("instapay_over_limit");
    }
  } else {
    if (requireAccount && listed !== null && listed.length >= 1 && !hasAccount(fields.collectionAccountId)) {
      errors.add("account_required");
    }
    const l4 = normalizeLast4(fields.payerPhoneLast4);
    if (l4 && !LAST4_RE.test(l4)) errors.add("payer_last4_invalid");
    const ref = normalizeReference(fields.payerReference);
    if (ref && !REFERENCE_RE.test(ref)) errors.add("reference_invalid");
    if (fields.paymentMethod === "instapay" && ctx.total > INSTAPAY_MAX_PER_TRANSFER) warnings.add("instapay_over_limit");
  }

  const order: TransferErrorCode[] = [
    "account_required",
    "part_amount_invalid",
    "parts_exceed_total",
    "too_many_parts",
    "payer_last4_invalid",
    "reference_invalid",
  ];
  const out = order.filter((c) => errors.has(c));
  return { ok: out.length === 0, errors: out, warnings: [...warnings] };
}

// ─── the POST body (08 §4.3) ─────────────────────────────────────────────────

/** The collection subset of CartOptions this module writes. */
export type CollectionOptions = Pick<
  CartOptions,
  "collectionAccountId" | "payerPhoneLast4" | "payerReference" | "collectionParts"
>;

/**
 * What the cart adds to `options` (the rest of the body is unchanged):
 *  - cash / card / deferred, or the feature off → nothing (stale fields ignored);
 *  - digital single → `collectionAccountId` when picked, payer hints when typed;
 *  - digital split → `collectionParts` only (each part WITH its account, 03
 *    §B.17), never the top-level single fields.
 * `total` is accepted for the call-site's symmetry with validateTransfer; the
 * body never clamps (the client refuses Σparts > total before it gets here).
 * The same object rides the live POST and the outbox, so a replay under the
 * same Idempotency-Key is byte-identical.
 */
export function collectionOptionsFromCart(
  fields: CartPaymentFields,
  _total: number,
  collectionsOn: boolean,
): CollectionOptions {
  if (!collectionsOn || !isDigitalMethod(fields.paymentMethod)) return {};
  if (fields.collectionParts.length > 0) {
    return {
      collectionParts: fields.collectionParts
        .filter((p): p is CollectionPartDraft & { accountId: string } => p.accountId != null)
        .map((p) => {
          const l4 = normalizeLast4(p.payerPhoneLast4);
          const ref = normalizeReference(p.payerReference);
          return {
            accountId: p.accountId,
            amount: fromPiasters(toPiasters(p.amount)),
            ...(l4 ? { payerPhoneLast4: l4 } : {}),
            ...(ref ? { payerReference: ref } : {}),
          };
        }),
    };
  }
  const l4 = normalizeLast4(fields.payerPhoneLast4);
  const ref = normalizeReference(fields.payerReference);
  return {
    ...(fields.collectionAccountId ? { collectionAccountId: fields.collectionAccountId } : {}),
    ...(l4 ? { payerPhoneLast4: l4 } : {}),
    ...(ref ? { payerReference: ref } : {}),
  };
}

/**
 * The inverse, for offline **Edit** (`loadSaleIntoCart`): a stored body back
 * into the cart's payment fields. `collectionOptionsFromCart(cartPaymentFromOptions(o))`
 * equals the collection subset of `o` (the round-trip test).
 */
export function cartPaymentFromOptions(options: CartOptions | null | undefined): CartPaymentFields {
  const o = options ?? {};
  const paymentMethod: PaymentMethod = o.paymentMethod ?? "cash";
  if (Array.isArray(o.collectionParts) && o.collectionParts.length > 0) {
    return {
      paymentMethod,
      collectionAccountId: null,
      payerPhoneLast4: "",
      payerReference: "",
      collectionParts: o.collectionParts.map((p) => ({
        accountId: p.accountId ?? null,
        amount: Number(p.amount) || 0,
        payerPhoneLast4: p.payerPhoneLast4 ?? "",
        payerReference: p.payerReference ?? "",
      })),
    };
  }
  return {
    paymentMethod,
    collectionAccountId: o.collectionAccountId ?? null,
    payerPhoneLast4: o.payerPhoneLast4 ?? "",
    payerReference: o.payerReference ?? "",
    collectionParts: [],
  };
}

/** For /sync and the outbox summary: the method and every account the body names. */
export function paymentSummaryOf(options: CartOptions | null | undefined): {
  paymentMethod: PaymentMethod | null;
  collectionAccountIds: string[];
} {
  const o = options ?? {};
  const ids =
    Array.isArray(o.collectionParts) && o.collectionParts.length > 0
      ? o.collectionParts.map((p) => p.accountId).filter((id): id is string => typeof id === "string" && id.length > 0)
      : o.collectionAccountId
        ? [o.collectionAccountId]
        : [];
  return { paymentMethod: o.paymentMethod ?? null, collectionAccountIds: [...new Set(ids)] };
}

// ─── typed input ─────────────────────────────────────────────────────────────

/**
 * An Arabic keypad types Arabic-Indic (٠–٩) or Persian (۰–۹) digits and the
 * Arabic decimal separator "٫"; everything the panel parses goes through
 * ASCII first (same idea as lib/customer-phone.ts asciifyDigits).
 */
export function asciiDigits(s: string): string {
  return (s ?? "")
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, ".");
}

/** A typed amount → EGP with at most 2 decimals; junk → 0. */
export function parseAmountInput(s: string): number {
  const cleaned = asciiDigits(s).replace(/,/g, "").replace(/[^\d.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/** The last-4 field keeps ASCII digits only, at most 4. */
export function cleanLast4Input(s: string): string {
  return asciiDigits(s).replace(/\D/g, "").slice(0, 4);
}

// ─── display ─────────────────────────────────────────────────────────────────

/**
 * "+201012345678" / "01012345678" → "010 1234 5678" (the way an Egyptian
 * number is read out). Anything else comes back unchanged.
 */
export function formatWalletNumber(msisdn: string | null | undefined): string {
  if (!msisdn) return "";
  const digits = msisdn.replace(/[\s-]/g, "");
  const m = /^(?:\+?20)?(0?1\d{9})$/.exec(digits);
  if (!m) return msisdn;
  const local = m[1]!.startsWith("0") ? m[1]! : `0${m[1]}`;
  return `${local.slice(0, 3)} ${local.slice(3, 7)} ${local.slice(7)}`;
}

/**
 * The one line that tells the cashier (and the customer) which account this
 * is (08 §4.2 item 3): the IPA handle, the wallet number, or "•••• 4821" for
 * a bank account known by its last 4 digits. NEVER an IBAN (03 §E.5): the
 * last resort is the server's ASCII mask ("***1234" / "***@instapay").
 */
export function accountIdentity(account: Pick<AccountLike, "rail" | "ipaHandle" | "walletMsisdn" | "accountLast4" | "mask">): string {
  if (account.rail === "wallet" && account.walletMsisdn) return formatWalletNumber(account.walletMsisdn);
  if (account.ipaHandle) return account.ipaHandle;
  if (account.walletMsisdn) return formatWalletNumber(account.walletMsisdn);
  if (account.accountLast4) return `•••• ${account.accountLast4}`;
  return account.mask ?? "";
}
