// Digital collections — allowlist redaction of a bank / wallet message before
// any developer sees it (spec 15 §4.10.1–4.10.2, 03 §D.6 / ARCH CR 4).
//
// PURE: no IO, no env, no clock. The IO shell is
// scripts/collections-export-shared-samples.ts; the unit test is
// tests/unit/collections-export-redact.test.ts.
//
// Rules, applied to title, subtitle and body (§4.10.2):
//   R1 digits normalised to ASCII (letters left as written)
//   R2 protected spans: footer-allowlisted URLs, dates, times, amounts — kept
//   R4 8-char hex references with a digit and a letter: first 4 → x
//   R3 digit runs (single spaces / "-" may join groups) of ≥ 7 digits: all but
//      the last 4 → x
//   R5 the bank's own masks (runs of * or x) — kept
//   R6 every letter token outside the vocabulary / allowWords → <Wn>
//   R7 URLs outside the footer allowlist → <URL>
//   R8 numeric senders go through R3; alphanumeric / app senders are kept
// R4 runs before R3 so a hex reference like 9951576c (seven leading digits)
// is masked as a reference (xxxx576c), not as a digit run (§7 case).
//
// Why an allowlist and not name detection: a missed name reaches a developer
// (03 §D.6 forbids it); an over-masked word is recovered by --allow-word after
// the owner confirms it (§4.9.7 step 2). It fails safe.
//
// The vocabulary inputs come from spec 06 part B (order 18, landed
// 2026-10-18), which replaced the INTERIM copies order 12 carried
// (spec 15 §4.10.4):
//   published sample texts → SAMPLES.filter(kind === "published").map(published)
//   candidate keywords     → CANDIDATE_KEYWORDS (filter.ts)
//   footer domains         → COLLECTION_TEMPLATES.flatMap(footerDomains)
//   synthetic fill names   → the words of SAMPLES.flatMap(fills) replacements
//                            + this module's own <Wn> fills (R5)
//   applyFills             → re-exported from __fixtures__/samples.ts

import { SAMPLES } from "@matgary/domain/collections/__fixtures__/samples";
import { CANDIDATE_KEYWORDS } from "@matgary/domain/collections/filter";
import { normalizeDigits, normalizeText } from "@matgary/domain/collections/normalize";
import { COLLECTION_TEMPLATES } from "@matgary/domain/collections/templates/index";

export { applyFills } from "@matgary/domain/collections/__fixtures__/samples";

// ---------------------------------------------------------------------------
// Public types (§4.10.1)
// ---------------------------------------------------------------------------

export type RedactMode = "strict"; // one mode; a `names` heuristic was rejected (§4.10.2)

export interface RedactInput {
  title?: string | null;
  subtitle?: string | null;
  body: string;
  sender?: string | null;
  senderKind: "alphanumeric" | "numeric" | "app";
}

/** `url` is an addition to §4.10.1's union so R7 is reported, not hidden. */
export interface Redaction {
  kind: "digits" | "hex" | "word" | "url" | "sender";
  count: number;
}

export interface Redacted {
  title: string | null;
  subtitle: string | null;
  body: string;
  sender: string | null;
  /** [placeholder, synthetic replacement]; longest placeholder first, no duplicates. */
  fills: Array<readonly [string, string]>;
  redactions: Redaction[];
  /** Distinct <Wn> words in the record. */
  unknownWords: number;
}

// ---------------------------------------------------------------------------
// Vocabulary inputs owned by spec 06 part B (see the header)
// ---------------------------------------------------------------------------

/**
 * The masked published texts of 06 §4.14 (verbatim from _research/wallets.md
 * §5.1 and instapay.md §4.3). They contain no personal data: every name /
 * number is a mask.
 */
export const PUBLISHED_SAMPLE_TEXTS: readonly string[] = SAMPLES.filter((s) => s.kind === "published").map(
  (s) => s.published,
);

/** The union of every template's footerDomains (06 §4.10). */
export const FOOTER_DOMAINS: readonly string[] = [
  ...new Set(COLLECTION_TEMPLATES.flatMap((t) => t.footerDomains.map((d) => d.toLowerCase()))),
].sort();

/** The synthetic <Wn> fills of §4.10.2 (one name per script, cycled). */
const AR_FILLS = ["محمد", "احمد", "علي", "محمود", "حسن"];
const LATIN_FILLS = ["AHMED", "MOHAMED", "ALI", "MAHMOUD", "HASSAN"];

/**
 * Every word of every fixture `fills` replacement (06 §4.14) plus the
 * synthetic words of §4.10.2. R5 (spec 15 §8): these are synthetic NAMES, so
 * they are never vocabulary, even when a published text happens to contain
 * the same spelling (e.g. the preposition "على" folds to the name "علي").
 * Single letters (the "M" of the bank's own "ABDELAZEEZ M****") are skipped.
 */
export const FILL_NAMES: readonly string[] = [
  ...new Set([
    ...SAMPLES.flatMap((s) => s.fills.map(([, replacement]) => replacement))
      .flatMap((r) => r.split(/\s+/))
      .map((w) => w.replace(/[*]+$/, ""))
      .filter((w) => w.length >= 2 && !/[0-9٠-٩]/.test(w)),
    ...AR_FILLS,
    ...LATIN_FILLS,
  ]),
];

// ---------------------------------------------------------------------------
// Static vocabulary (§4.10.1)
// ---------------------------------------------------------------------------

const STATIC_WORDS: readonly string[] = [
  // currency
  "جنيه", "ج.م", "جم", "EGP", "LE",
  // providers and banks
  "InstaPay", "انستاباي", "Vodafone", "فودافون", "كاش", "Cash", "NBE", "الأهلي", "CIB", "QNB", "Orange", "اورنج",
  "e&", "money",
  // structure
  "رصيد", "رصيدك", "الحالي", "عملية", "رقم", "مرجعي", "تاريخ", "balance", "ref", "reference", "account", "card",
  "wallet", "محفظة", "حساب", "بطاقة",
  // months, en (long and short) and ar (Egyptian + Levantine names)
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
  "يناير", "فبراير", "مارس", "أبريل", "ابريل", "مايو", "يونيو", "يوليو", "أغسطس", "اغسطس", "سبتمبر", "أكتوبر",
  "اكتوبر", "نوفمبر", "ديسمبر", "كانون", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين",
];

// ---------------------------------------------------------------------------
// Tokens and keys
// ---------------------------------------------------------------------------

// Letter sub-tokens: letters, combining marks and "&" (for "e&"). Built with
// the RegExp constructor: the web tsconfig targets ES2017, and \p{…} /
// lookbehind need ES2018 in a literal.
const SUBTOKEN_RE = new RegExp("[\\p{L}\\p{M}&]+", "gu");
const HAS_LETTER_RE = new RegExp("[\\p{L}]", "u");
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/;
const MASK_LETTERS_RE = /^[xX]+$/;

/** Vocabulary key: 06's normalizeText folding, then lower case. */
function vocabKey(word: string): string {
  return normalizeText(word).toLowerCase();
}

/** Sub-tokens of a text, each with its letters (for the vocabulary). */
function wordsOf(text: string): string[] {
  // placeholders (<NAME>, <SENDER NAME, …>) and URLs carry no vocabulary
  const cleaned = text.replace(/<[^>]*>/g, " ").replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  const out: string[] = [];
  for (const chunk of cleaned.split(/\s+/)) {
    if (!chunk) continue;
    const core = stripEdges(chunk);
    if (core && HAS_LETTER_RE.test(core)) out.push(core);
    for (const m of chunk.matchAll(SUBTOKEN_RE)) {
      if (HAS_LETTER_RE.test(m[0]) && !MASK_LETTERS_RE.test(m[0])) out.push(m[0]);
    }
  }
  return out;
}

const EDGE_RE = new RegExp("^[^\\p{L}\\p{M}\\p{N}&]+|[^\\p{L}\\p{M}\\p{N}&]+$", "gu");
function stripEdges(chunk: string): string {
  return chunk.replace(EDGE_RE, "");
}

/**
 * The normalised vocabulary (§4.10.1): published-sample tokens, the candidate
 * keywords, the static list and `extra`, minus every synthetic fill name (R5).
 */
export function buildVocabulary(extra?: Iterable<string>): Set<string> {
  const vocab = new Set<string>();
  const add = (w: string) => {
    for (const part of [w, ...wordsOf(w)]) {
      const k = vocabKey(part);
      if (k && HAS_LETTER_RE.test(k)) vocab.add(k);
    }
  };
  for (const text of PUBLISHED_SAMPLE_TEXTS) for (const w of wordsOf(text)) add(w);
  for (const w of [...CANDIDATE_KEYWORDS.ar, ...CANDIDATE_KEYWORDS.en]) {
    add(w);
    for (const part of w.split(/\s+/)) add(part);
  }
  for (const w of STATIC_WORDS) add(w);
  if (extra) for (const w of extra) add(w);
  for (const name of FILL_NAMES) vocab.delete(vocabKey(name));
  return vocab;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// Internal markers (Unicode private use; never in a real message):
//   \uE000 <slot> \uE001  a protected span (slot index = code - SLOT_BASE)
//   \uE002                one masked character, rendered "x" at the end
const P_OPEN = "\uE000";
const P_CLOSE = "\uE001";
const MASK = "\uE002";
const MASK_ALL_RE = /\uE002/g;
const SLOT_BASE = 0xe100;
const SLOT_RE = /\uE000([\uE100-\uF8FF])\uE001/g;
const MARKER_RE = /[\uE000-\uF8FF]/;

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const DATE_RE = new RegExp("(?<!\\d)(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4})(?!\\d)", "g");
const TIME_RE = new RegExp("(?<!\\d)\\d{1,2}:\\d{2}(?::\\d{2})?(?: ?[AaPp][Mm](?![A-Za-z]))?(?!\\d)", "g");
const CUR = "(?:EGP|LE|جنيه|ج\\.م|جم)";
const AMOUNT_RES: readonly RegExp[] = [
  // 64,500.00 · 1,000
  new RegExp("(?<![\\d.,])\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?(?!\\d)", "g"),
  // 2700.00 · 500.5
  new RegExp("(?<![\\d.,])\\d+\\.\\d{1,2}(?!\\d)", "g"),
  // 20000EGP · 1500 جنيه
  new RegExp(`(?<![\\d.,])\\d+(?= ?${CUR}(?![\\p{L}]))`, "gu"),
  // EGP 20000
  new RegExp("(?<=(?<![A-Za-z])(?:EGP|LE) ?)\\d+(?![\\d.,])", "g"),
];
const HEX8_RE = new RegExp("(?<![0-9A-Za-z])[0-9a-fA-F]{8}(?![0-9A-Za-z])", "g");
const DIGIT_RUN_RE = new RegExp("(?<!\\d)\\d+(?:[ -]\\d+)*(?!\\d)", "g");

function urlHost(url: string): string | null {
  try {
    const u = new URL(/^www\./i.test(url) ? `http://${url}` : url);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostAllowed(host: string | null, footer: readonly string[]): boolean {
  if (!host) return false;
  return footer.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The URL without trailing sentence punctuation (".", ",", "،", ")", …). */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?)\]}'"،؛…]+$/, "");
}

/**
 * R3 on one string: every run of ≥ 7 digits (groups joined by one space or
 * "-") keeps its last 4 digits; the others become MASK. `onMask` receives the
 * masked run rendered with "x".
 */
function maskDigitRuns(s: string, onMask: (rendered: string) => void): string {
  return s.replace(DIGIT_RUN_RE, (run) => {
    if (run.replace(/\D/g, "").length < 7) return run;
    let keep = 4;
    const chars = run.split("");
    for (let i = chars.length - 1; i >= 0; i--) {
      if (!/\d/.test(chars[i])) continue;
      if (keep > 0) keep--;
      else chars[i] = MASK;
    }
    const masked = chars.join("");
    onMask(masked.replace(MASK_ALL_RE, "x"));
    return masked;
  });
}

const URL_FILL = "http://example.invalid/x";

interface RecordState {
  vocab: Set<string>;
  allow: Set<string>;
  words: Map<string, { n: number; arabic: boolean }>;
  counts: Record<Redaction["kind"], number>;
  /** Our own x masks (digit runs, hex refs), as rendered → their fill. */
  masks: Map<string, string>;
}

function isKnown(word: string, st: RecordState): boolean {
  const k = vocabKey(word);
  return st.allow.has(k) || st.vocab.has(k);
}

function redactField(input: string, st: RecordState): string {
  // R1
  let s = normalizeDigits(input);
  const slots: string[] = [];
  const protect = (text: string): string => {
    slots.push(text);
    return P_OPEN + String.fromCharCode(SLOT_BASE + slots.length - 1) + P_CLOSE;
  };

  // R2 (allowlisted URLs) + R7 (every other URL)
  s = s.replace(URL_RE, (raw) => {
    const url = trimUrl(raw);
    const rest = raw.slice(url.length);
    if (hostAllowed(urlHost(url), FOOTER_DOMAINS)) return protect(url) + rest;
    st.counts.url++;
    return protect("<URL>") + rest;
  });
  // R2 (dates, times, amounts)
  s = s.replace(DATE_RE, (m) => protect(m));
  s = s.replace(TIME_RE, (m) => protect(m));
  for (const re of AMOUNT_RES) s = s.replace(re, (m) => protect(m));

  // R4 (before R3, see the header). The masked token is protected so R6
  // never reads its trailing hex letters as a word.
  s = s.replace(HEX8_RE, (tok) => {
    if (!/\d/.test(tok) || !/[a-f]/i.test(tok)) return tok;
    st.counts.hex++;
    const rendered = "xxxx" + tok.slice(4);
    st.masks.set(rendered, "7777" + tok.slice(4));
    return protect(rendered);
  });
  // R3
  s = maskDigitRuns(s, (rendered) => {
    st.counts.digits++;
    st.masks.set(rendered, rendered.replace(/x/g, "7"));
  });

  // R5 + R6: letter sub-tokens outside the vocabulary become <Wn>
  s = s
    .split(/(\s+)/)
    .map((chunk) => {
      if (!chunk || /^\s+$/.test(chunk)) return chunk;
      const core = stripEdges(chunk);
      if (core && !MARKER_RE.test(core) && HAS_LETTER_RE.test(core) && isKnown(core, st)) return chunk;
      return chunk.replace(SUBTOKEN_RE, (sub) => {
        if (!HAS_LETTER_RE.test(sub)) return sub;
        if (MASK_LETTERS_RE.test(sub)) return sub; // R5: the bank's own x mask
        if (isKnown(sub, st)) return sub;
        const key = vocabKey(sub);
        let w = st.words.get(key);
        if (!w) {
          w = { n: st.words.size + 1, arabic: ARABIC_RE.test(sub) };
          st.words.set(key, w);
        }
        st.counts.word++;
        return `<W${w.n}>`;
      });
    })
    .join("");

  // restore the protected spans, render the masks
  s = s.replace(SLOT_RE, (_m, c: string) => slots[c.charCodeAt(0) - SLOT_BASE]);
  return s.replace(MASK_ALL_RE, "x");
}

/**
 * Redact one record (§4.10.2). Deterministic: the same input, vocabulary and
 * allowWords give the same output; <Wn> numbers are per record, in order of
 * first appearance over title → subtitle → body; the same word (after
 * normalizeText folding, case-insensitive) keeps its number.
 */
export function redactSample(input: RedactInput, vocab: Set<string>, allowWords?: Iterable<string>): Redacted {
  const st: RecordState = {
    vocab,
    allow: new Set([...(allowWords ?? [])].map(vocabKey).filter(Boolean)),
    words: new Map(),
    counts: { digits: 0, hex: 0, word: 0, url: 0, sender: 0 },
    masks: new Map(),
  };
  const field = (v: string | null | undefined) => (v === null || v === undefined ? null : redactField(v, st));
  const title = field(input.title);
  const subtitle = field(input.subtitle);
  const body = redactField(input.body, st);

  // R8: bank / app sender ids are not personal; a numeric sender is a phone.
  let sender: string | null = input.sender ?? null;
  if (sender !== null && input.senderKind === "numeric") {
    sender = maskDigitRuns(normalizeDigits(sender), () => st.counts.sender++).replace(MASK_ALL_RE, "x");
  }

  // fills (§4.10.2, 06 §4.14 convention): our x → 7 (the bank's own masks are
  // not filled), <Wn> → a fixed synthetic name in the word's script,
  // <URL> → http://example.invalid/x. Longest placeholder first, so a short
  // one can never rewrite part of a longer one.
  const fills = new Map<string, string>();
  for (const [, w] of st.words) {
    const names = w.arabic ? AR_FILLS : LATIN_FILLS;
    fills.set(`<W${w.n}>`, names[(w.n - 1) % names.length]);
  }
  if (st.counts.url > 0) fills.set("<URL>", URL_FILL);
  for (const [ph, rep] of st.masks) fills.set(ph, rep);

  return {
    title,
    subtitle,
    body,
    sender,
    fills: [...fills.entries()].sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    redactions: (["digits", "hex", "word", "url", "sender"] as const)
      .filter((k) => st.counts[k] > 0)
      .map((kind) => ({ kind, count: st.counts[kind] })),
    unknownWords: st.words.size,
  };
}
