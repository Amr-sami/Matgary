// Digital collections — parseMessage (spec 06 §4.11, part B; 03 §D.1–D.4).
//
// Turns one forwarded bank / wallet message into a status + fields. Pure: no
// IO, no clock except the injectable `opts.now`. Server-authoritative (Q13):
// it uses named groups, the dotAll flag and Intl (Africa/Cairo), and degrades
// to `receivedAt` where Intl time zones are missing (Hermes without tz data).
// Spec 07 calls it inside its ingest transaction; `duplicate` is assigned by
// 07's raw dedupe, never here.
//
// Algorithm (the first matching rule wins):
//   1 text = normalizeText(messageText(input)); senderKind = senderKindOf(…)
//   2 OTP → `otp`, every field null
//   3 now − receivedAt > MAX_AGE_H → `too_old`
//   4 templates ordered: sender / package matched first, then registry order;
//     the first regex hit wins
//   5 on a hit: fields (credits only carry payer phone / name; the
//     counterparty of a debit is never returned); zero amount → `not_credit`;
//     recognised debits and cash-ins are `parsed` (06 ARCH CR 4)
//   6 the date rule (resolveOccurredAt)
//   7 links: suspicious unless on the hit template's footer allowlist
//   8 senderMatched
//   9 no hit → the §D.4 fallback (credit word + exactly one amount)
//  10 budget: bodies ≤ 2,000 characters; every regex anchored

import { isOtp } from "./filter";
import { MATCH_CONSTANTS } from "./match";
import { fromPiasters, normalizeEgyptMobile, normalizeSender, normalizeText, senderKindOf, toPiasters } from "./normalize";
import { COLLECTION_TEMPLATES } from "./templates/index";
import type {
  CollectionTemplate,
  DateOrder,
  IngestChannel,
  ParsedFields,
  ParseInput,
  ParseResult,
  SenderKind,
} from "./types";

export const FALLBACK_TEMPLATE_ID = "generic.fallback.v1";

/** Non-empty title, subtitle and body joined by "\n" (notification templates key on this). */
export function messageText(i: Pick<ParseInput, "title" | "subtitle" | "body">): string {
  const parts: string[] = [];
  for (const p of [i.title, i.subtitle, i.body]) if (p != null && String(p) !== "") parts.push(String(p));
  return parts.join("\n");
}

const SMS_CHANNELS: ReadonlySet<IngestChannel> = new Set<IngestChannel>(["ios_sms", "android_sms"]);
const NOTIFICATION_CHANNELS: ReadonlySet<IngestChannel> = new Set<IngestChannel>([
  "ios_notification",
  "android_notification",
]);

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

function toDate(v: Date | string): Date {
  return v instanceof Date ? new Date(v.getTime()) : new Date(v);
}

// ---------------------------------------------------------------------------
// Date rule (step 6)
// ---------------------------------------------------------------------------

const CAIRO = "Africa/Cairo";
let cairoFormatter: Intl.DateTimeFormat | null | undefined;

function getCairoFormatter(): Intl.DateTimeFormat | null {
  if (cairoFormatter !== undefined) return cairoFormatter;
  try {
    cairoFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: CAIRO,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    cairoFormatter = null; // no time-zone data: every date falls back to receivedAt
  }
  return cairoFormatter;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** Cairo wall-clock parts of a UTC instant. Throws when Intl lacks the zone. */
function cairoWall(utcMs: number): Wall {
  const f = getCairoFormatter();
  if (!f) throw new Error("Intl time zones unavailable");
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
  };
}

/** Offset of Cairo from UTC at this instant, in ms. */
function cairoOffsetMs(utcMs: number): number {
  const w = cairoWall(utcMs);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const flooredUtc = Math.floor(utcMs / MIN_MS) * MIN_MS;
  return asUtc - flooredUtc;
}

/** A Cairo wall time → UTC ms, iterating the offset twice (DST aware). */
function cairoWallToUtc(w: Wall): number {
  const wallMs = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let guess = wallMs - cairoOffsetMs(wallMs);
  guess = wallMs - cairoOffsetMs(guess);
  return guess;
}

function validCalendar(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function yearOf(s: string): number {
  const n = parseInt(s, 10);
  return s.length <= 2 ? 2000 + n : n;
}

/**
 * Resolve the message's own time. Every candidate reading (each dateOrder,
 * and for year-less templates receivedAt's Cairo year and the year before)
 * that is a valid calendar date in [receivedAt − 72 h, receivedAt + 15 min]
 * is kept; exactly one distinct instant → "message", otherwise "received".
 */
function resolveOccurredAt(
  t: CollectionTemplate,
  g: Record<string, string | undefined>,
  receivedAt: Date,
): { occurredAt: string; occurredAtSource: "message" | "received" } {
  const fallback = { occurredAt: receivedAt.toISOString(), occurredAtSource: "received" as const };
  if (t.dateOrder.length === 0 || g.d1 === undefined || g.d2 === undefined || g.time === undefined) return fallback;
  const tm = /^(\d{1,2}):(\d{2})$/.exec(g.time);
  if (!tm) return fallback;
  let hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  if (g.ampm !== undefined) {
    if (hour < 1 || hour > 12) return fallback;
    const pm = g.ampm.toUpperCase() === "PM";
    hour = hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
  }
  if (hour > 23 || minute > 59) return fallback;

  const lo = receivedAt.getTime() - 72 * HOUR_MS;
  const hi = receivedAt.getTime() + 15 * MIN_MS;
  const instants = new Set<number>();
  try {
    const receivedYear = cairoWall(receivedAt.getTime()).y;
    const d = [g.d1, g.d2, g.d3];
    for (const order of t.dateOrder as readonly DateOrder[]) {
      let y: number[] = [];
      let mo: number;
      let day: number;
      switch (order) {
        case "YMD":
          if (d[2] === undefined) continue;
          y = [yearOf(d[0] as string)];
          mo = parseInt(d[1] as string, 10);
          day = parseInt(d[2], 10);
          break;
        case "DMY":
          if (d[2] === undefined) continue;
          day = parseInt(d[0] as string, 10);
          mo = parseInt(d[1] as string, 10);
          y = [yearOf(d[2])];
          break;
        case "MDY":
          if (d[2] === undefined) continue;
          mo = parseInt(d[0] as string, 10);
          day = parseInt(d[1] as string, 10);
          y = [yearOf(d[2])];
          break;
        case "MD":
          mo = parseInt(d[0] as string, 10);
          day = parseInt(d[1] as string, 10);
          y = [receivedYear, receivedYear - 1];
          break;
        case "DM":
          day = parseInt(d[0] as string, 10);
          mo = parseInt(d[1] as string, 10);
          y = [receivedYear, receivedYear - 1];
          break;
        default:
          continue;
      }
      for (const year of y) {
        if (!validCalendar(year, mo, day)) continue;
        const utc = cairoWallToUtc({ y: year, mo, d: day, h: hour, mi: minute });
        if (utc >= lo && utc <= hi) instants.add(utc);
      }
    }
  } catch {
    return fallback; // Intl threw (no tz data)
  }
  if (instants.size !== 1) return fallback;
  const [only] = [...instants];
  return { occurredAt: new Date(only).toISOString(), occurredAtSource: "message" };
}

// ---------------------------------------------------------------------------
// Links (step 7)
// ---------------------------------------------------------------------------

const LINK_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi;

function hostOf(link: string): string {
  const noScheme = link.replace(/^https?:\/\//i, "");
  const host = noScheme.split("/")[0].toLowerCase();
  return host.replace(/^www\./, "");
}

function linksOf(text: string, template: CollectionTemplate | null): { links: string[]; suspicious: string[] } {
  const links: string[] = [];
  const suspicious: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const link = m[0];
    links.push(link);
    const host = hostOf(link);
    const allowed =
      template !== null && template.footerDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
    if (!allowed) suspicious.push(link);
  }
  return { links, suspicious };
}

// ---------------------------------------------------------------------------
// Fallback (step 9, 03 §D.4)
// ---------------------------------------------------------------------------

const AMT_SRC = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const CUR_SRC = String.raw`(?:EGP|جم|ج\.م|جنيه)`;
const CREDIT_WORDS_RE = /تم استلام|تم اضافه|تم ايداع|تم استقبال|(^|[^a-z])(received|credited)([^a-z]|$)/i;
const DEBIT_WORDS_RE = /تم تحويل|تم سحب|تم دفع|تم خصم|(^|[^a-z])(sent|charged)([^a-z]|$)/i;
// Each pattern captures the number in group 1; `numberAtEnd` tells where the
// number sits in the match (for the 25-character balance look-back).
const FALLBACK_AMOUNT_RES: ReadonlyArray<{ re: RegExp; numberAtEnd: boolean }> = [
  { re: new RegExp(String.raw`(?:بمبلغ|مبلغ|amount(?: of)?) ?${CUR_SRC}? ?(${AMT_SRC})(?![\d.,]*\d)`, "gi"), numberAtEnd: true },
  { re: new RegExp(String.raw`(?<![\d.,])(${AMT_SRC}) ?(?:EGP|جم|ج\.م|جنيه|LE)`, "gi"), numberAtEnd: false },
  { re: new RegExp(String.raw`(?:EGP|LE) ?(${AMT_SRC})(?![\d.,]*\d)`, "gi"), numberAtEnd: true },
];
const BALANCE_WORD_RE = /رصيد|balance/i;

/** Distinct (by piasters) amounts in the text that are not a balance. */
function fallbackAmounts(text: string): number[] {
  const seen = new Set<number>();
  for (const { re, numberAtEnd } of FALLBACK_AMOUNT_RES) {
    for (const m of text.matchAll(re)) {
      const num = m[1];
      const start = (m.index ?? 0) + (numberAtEnd ? m[0].length - num.length : 0);
      const before = text.slice(Math.max(0, start - 25), start);
      if (BALANCE_WORD_RE.test(before)) continue;
      let pt: number;
      try {
        pt = toPiasters(num);
      } catch {
        continue;
      }
      seen.add(pt);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

function emptyResult(
  status: ParseResult["status"],
  senderKind: SenderKind,
  extra: Partial<ParseResult> = {},
): ParseResult {
  return {
    status,
    templateId: null,
    provider: null,
    rail: null,
    direction: null,
    fields: null,
    confidence: null,
    senderKind,
    senderMatched: false,
    links: [],
    suspiciousLinks: [],
    ...extra,
  };
}

function orderTemplates(
  input: ParseInput,
  templates: readonly CollectionTemplate[],
): CollectionTemplate[] {
  const notification = NOTIFICATION_CHANNELS.has(input.channel);
  const sender = normalizeSender(input.sender);
  const app = input.sourceApp ?? null;
  const first: CollectionTemplate[] = [];
  const rest: CollectionTemplate[] = [];
  for (const t of templates) {
    const preferred = notification
      ? app !== null && t.packages.indexOf(app) !== -1
      : sender !== "" && t.senderIds.some((s) => normalizeSender(s) === sender);
    (preferred ? first : rest).push(t);
  }
  return [...first, ...rest];
}

function senderMatchedFor(input: ParseInput, senderKind: SenderKind, t: CollectionTemplate): boolean {
  if (input.channel === "manual_paste") return false;
  if (SMS_CHANNELS.has(input.channel)) {
    const s = normalizeSender(input.sender);
    return senderKind === "alphanumeric" && s !== "" && t.senderIds.some((id) => normalizeSender(id) === s);
  }
  if (NOTIFICATION_CHANNELS.has(input.channel)) {
    return input.sourceApp != null && t.packages.indexOf(input.sourceApp) !== -1;
  }
  return false;
}

/**
 * Parse one forwarded message (03 §D.1). `opts.now` (default `new Date()`)
 * and `opts.templates` (default COLLECTION_TEMPLATES) keep tests
 * deterministic.
 */
export function parseMessage(
  input: ParseInput,
  opts?: { now?: Date; templates?: readonly CollectionTemplate[] },
): ParseResult {
  const now = opts?.now ? opts.now.getTime() : Date.now();
  const templates = opts?.templates ?? COLLECTION_TEMPLATES;
  const receivedAt = toDate(input.receivedAt);
  const maxAgeMs = MATCH_CONSTANTS.MAX_AGE_H * HOUR_MS;

  // 1
  const text = normalizeText(messageText(input));
  const senderKind = senderKindOf(input.channel, input.sender);

  // 2
  if (isOtp(text)) return emptyResult("otp", senderKind);

  // 3
  if (Number.isNaN(receivedAt.getTime()) || now - receivedAt.getTime() > maxAgeMs) {
    return emptyResult("too_old", senderKind);
  }

  // 4
  for (const t of orderTemplates(input, templates)) {
    const m = t.regex.exec(text);
    if (!m) continue;
    const g = (m.groups ?? {}) as Record<string, string | undefined>;
    const { links, suspicious } = linksOf(text, t);
    const base: Partial<ParseResult> = {
      templateId: t.id,
      provider: t.provider,
      rail: t.rail,
      direction: t.direction,
      confidence: "exact",
      senderMatched: senderMatchedFor(input, senderKind, t),
      links,
      suspiciousLinks: suspicious,
    };

    // 5
    let amountPt: number;
    try {
      amountPt = toPiasters(g.amount ?? "");
    } catch {
      continue; // an unparseable amount is not this template
    }
    if (amountPt === 0) return emptyResult("not_credit", senderKind, base);
    let balanceAfter: string | null = null;
    if (g.balance !== undefined) {
      try {
        balanceAfter = fromPiasters(toPiasters(g.balance));
      } catch {
        balanceAfter = null;
      }
    }
    const isCredit = t.direction === "credit";
    const receivingHint = g.hint ?? (g.receiving !== undefined ? g.receiving.slice(-4) : null);
    const name = isCredit && g.name !== undefined ? g.name.trim() : null;

    // 6
    const when = resolveOccurredAt(t, g, receivedAt);

    const fields: ParsedFields = {
      amount: fromPiasters(amountPt),
      currency: "EGP",
      payerPhone: isCredit ? (normalizeEgyptMobile(g.payer)?.national ?? null) : null,
      payerName: name === "" ? null : name,
      balanceAfter,
      reference: g.ref !== undefined ? g.ref.toLowerCase() : null,
      receivingHint,
      occurredAt: when.occurredAt,
      occurredAtSource: when.occurredAtSource,
    };
    const status: ParseResult["status"] = now - Date.parse(when.occurredAt) > maxAgeMs ? "too_old" : "parsed";
    return { ...emptyResult(status, senderKind, base), fields };
  }

  // 9 — no template hit
  const { links, suspicious } = linksOf(text, null);
  const withLinks = { links, suspiciousLinks: suspicious };
  if (!CREDIT_WORDS_RE.test(text)) return emptyResult("not_credit", senderKind, withLinks);
  if (DEBIT_WORDS_RE.test(text)) return emptyResult("unknown_format", senderKind, withLinks);
  const amounts = fallbackAmounts(text);
  if (amounts.length !== 1) return emptyResult("unknown_format", senderKind, withLinks);
  if (amounts[0] === 0) return emptyResult("not_credit", senderKind, withLinks);
  return emptyResult("fallback", senderKind, {
    ...withLinks,
    templateId: FALLBACK_TEMPLATE_ID,
    direction: "credit",
    confidence: "fallback",
    fields: {
      amount: fromPiasters(amounts[0]),
      currency: "EGP",
      payerPhone: null,
      payerName: null,
      balanceAfter: null,
      reference: null,
      receivingHint: null,
      occurredAt: receivedAt.toISOString(),
      occurredAtSource: "received",
    },
  });
}
