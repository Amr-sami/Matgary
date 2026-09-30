// Digital collections — wallet and InstaPay limits (spec 06 §4.5).
//
// Sources (full URLs in _research/wallets.md and instapay.md):
// - Individual wallet limits EGP 60,000 / day and 200,000 / month: CBE,
//   19 Nov 2023 [DNE-2023]. They are published for OUTGOING money; whether
//   incoming transfers count is UNVERIFIED (W7), so every warning's copy says
//   "may".
// - New wallets (first 90 days) EGP 10,000 / day and 60,000 / month: published
//   for WE Pay and Orange Cash only [WE] [OR]; applied to every wallet
//   provider by default (D06-e, UNVERIFIED for VF, e&, NBE, BM — W10).
// - InstaPay: EGP 70,000 per transaction, 120,000 per day and 400,000 per
//   month per bank for SENDING; "no limits for receiving money" [IPN-QA]
//   (instapay.md §3). So the instapay rail never warns.
//
// Hermes-safe: plain Date.UTC arithmetic, no time-zone APIs.

import type { CollectionProvider, CollectionRail, LimitWarning } from "./types";
import { COLLECTION_PROVIDERS } from "./providers";
import { toPiasters } from "./normalize";

export const WALLET_LIMITS = {
  individual: { dayMax: 60_000, monthMax: 200_000 },
  newWallet: {
    days: 90,
    dayMax: 10_000,
    monthMax: 60_000,
    providers: "all" as "all" | readonly CollectionProvider[],
  },
  warnAtPct: 80,
  balanceWarnAtPct: 90,
} as const;

export const INSTAPAY_LIMITS = {
  perTransaction: 70_000,
  perDayPerBank: 120_000,
  perMonthPerBank: 400_000,
  /** "no limits for receiving money" [IPN-QA] */
  receiving: null,
} as const;

export interface LimitWarningsInput {
  rail: CollectionRail;
  provider: CollectionProvider;
  /** YYYY-MM-DD business day (Cairo). */
  date: string;
  /** `collection_accounts.wallet_opened_on`, YYYY-MM-DD. */
  walletOpenedOn: string | null;
  /** Decimal EGP; 13 recommends confirmed + auto_confirmed + pending. */
  dayReceived: string;
  monthReceived: string;
  /** `collection_accounts.balance_baseline` (L2 only). */
  balance: string | null;
}

const DAY_MS = 86_400_000;

function utcDay(ymd: string | null): number | null {
  if (ymd == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  // Reject calendar overflow such as 2026-02-30.
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

function newWalletRuleApplies(provider: CollectionProvider): boolean {
  const p = WALLET_LIMITS.newWallet.providers;
  return p === "all" || p.indexOf(provider) !== -1;
}

/**
 * The limit warnings of one receiving account on one business day, in the
 * fixed order day_80, month_80, new_wallet_day_80, balance_90. Thresholds are
 * inclusive: day ≥ 48,000; month ≥ 160,000; a wallet opened less than 90 days
 * before `date` with day ≥ 8,000; balance ≥ 90 % of the provider's cap
 * (skipped when the cap or the balance is null). The instapay rail always
 * gives [] because receiving is unlimited.
 */
export function limitWarnings(input: LimitWarningsInput): LimitWarning[] {
  if (input.rail === "instapay") return [];
  const out: LimitWarning[] = [];
  const pct = WALLET_LIMITS.warnAtPct;
  const dayPt = toPiasters(input.dayReceived);
  const monthPt = toPiasters(input.monthReceived);

  // EGP × pct = piasters × pct / 100, i.e. the threshold in piasters.
  if (dayPt >= WALLET_LIMITS.individual.dayMax * pct) out.push("day_80");
  if (monthPt >= WALLET_LIMITS.individual.monthMax * pct) out.push("month_80");

  const day = utcDay(input.date);
  const opened = utcDay(input.walletOpenedOn);
  if (day != null && opened != null && newWalletRuleApplies(input.provider)) {
    const ageDays = Math.floor((day - opened) / DAY_MS);
    if (ageDays < WALLET_LIMITS.newWallet.days && dayPt >= WALLET_LIMITS.newWallet.dayMax * pct) {
      out.push("new_wallet_day_80");
    }
  }

  const cap = COLLECTION_PROVIDERS[input.provider]?.balanceCap ?? null;
  if (cap != null && input.balance != null) {
    if (toPiasters(input.balance) >= cap * WALLET_LIMITS.balanceWarnAtPct) out.push("balance_90");
  }
  return out;
}

/**
 * An InstaPay part above EGP 70,000 cannot be sent in one transfer: the POS
 * suggests a split (03 §C.6). "70000.01" → "over_per_transaction"; "70000" → null.
 */
export function instapayPartWarning(amount: string): "over_per_transaction" | null {
  return toPiasters(amount) > INSTAPAY_LIMITS.perTransaction * 100 ? "over_per_transaction" : null;
}
