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
// M1 NOTE (as landed 2026-10-18): spec 06 part B (order 18: __fixtures__/
// samples.ts, filter.ts, templates/) has not landed. Three inputs it will own
// are therefore copied here, verbatim from the research notes / 06 §4.9–4.10,
// and marked INTERIM. When order 18 lands, replace them with imports:
//   INTERIM_PUBLISHED_SAMPLES  → SAMPLES.filter(kind === "published").map(published)
//   INTERIM_CANDIDATE_KEYWORDS → CANDIDATE_KEYWORDS (filter.ts)
//   INTERIM_FOOTER_DOMAINS     → COLLECTION_TEMPLATES.flatMap(footerDomains)
//   INTERIM_FILL_NAMES         → SAMPLES.flatMap(fills).map(replacement) words
//   applyFillsLocal            → applyFills (__fixtures__/samples.ts)

import { normalizeDigits, normalizeText } from "@matgary/domain/collections/normalize";

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
// INTERIM inputs owned by spec 06 part B (see the header)
// ---------------------------------------------------------------------------

/**
 * = SAMPLES.filter(s => s.kind === "published").map(s => s.published)
 * The masked texts of 06 §4.14, verbatim from _research/wallets.md §5.1 and
 * instapay.md §4.3 (research annotations such as "(12 digits)" dropped).
 * They contain no personal data: every name / number is a mask.
 */
export const INTERIM_PUBLISHED_SAMPLES: readonly string[] = [
  // VF-1
  "تم استلام مبلغ 2700.00 جنيه من رقم 0112xxxxx05 المسجل بإسم <NAME> على رقم محفظتك  0100xxxxx65.\nرصيدك الحالي: 2724.51 جنيه\nتاريخ العملية: 17:36 26-07-27\nرقم العملية: 0221xxxxxxxx\nتابع كل مصروفاتك من تاريخ المعاملات على أبلكيشن أنا فودافون http://vf.eg/vfcash",
  // VF-2
  "تم تحويل مبلغ 500.00 جنيه الى رقم 0106xxxxx46 بنجاح. رصيدك الحالي: 10.00 جنيه",
  // EM-1
  "تم إستلام مبلغ 200.00 ج.م من رقم 0106xxxxx46 المسجل باسم<NAME> بنجاح. رصيد محفظتك الحالى 429.90 ج.م.استخدم e& money هتكسب و العب هتكسب هدايا تانية كتير http://spr.ly/Spin_The_Wheel وكمان تقدر تستمتع بخصم %30على وجبة كومبو من Buffalo Burger ب 160 جنيه بدل225 لما تدفع ب http://spr.ly/BuffaloBurger2 e& money",
  // EM-2
  "تم إيداع مبلغ 1.00  في حسابك بنجاح من رقم حساب 00201000xxxxx المسجل باسم <NAME>\n استخدم e& money هتكسب و العب هتكسب هدايا تانية كتير http://spr.ly/Spin_The_Wheel",
  // OC-1
  "تم إستلام عملية تحويل أموال بمبلغ 150.00 جنيه من <NAME>، رصيدك الحالي 366.22 جنيه. رقم المعاملة 19082xxxxx\n100 جنيه كاش باك لما تحول، تدفع او تودع فلوس في محفظة اورنچ كاش",
  // OC-2
  "تم إستلام عملية تحويل اموال بمبلغ ٢٠٠٠.٠٠ جنيه من <NAME> ، رقم المعاملة ٢٠٥٢٧xxxxx\nكاش باك أو دقائق أو ميجابايتس كل ما تستعلم ...",
  // OC-3
  "Successful cash-in with amount EGP 6.43.\nYour current balance is EGP 6.43\n… Dial #71# to join the gold Competition … https://myo.orange.eg/OC-IN",
  // IP-NBE-1
  "تم إضافة تحويل لحظي لحسابكم رقم 0150 بمبلغ 5000.00 جم من <SENDER NAME, Latin caps, cut: 25 chars> رقم مرجعي 125073164743 يوم 05-04 الساعة 12:25 للمزيد اتصل بـ 19623",
  // IP-NBE-2a, IP-NBE-2b
  "تم إضافة تحويل لحظي لبطاقتكم مسبقة الدفع بمبلغ 10000.00 جم من <SENDER NAME, Latin caps, 38 chars> رقم مرجعي 937478492117 يوم 07-02 الساعة 15:59 للمزيد اتصل بـ 19623",
  "تم إضافة تحويل لحظي لبطاقتكم مسبقة الدفع بمبلغ 300.00 جم من <SENDER NAME, Arabic, 6 words> رقم مرجعي 509818302771 يوم 08-12 الساعة 23:27 للمزيد اتصل بـ 19623",
  // IP-NBE-3
  "تم تنفيذ تحويل لحظي من حسابكم رقم 0150 بمبلغ 150.00 جم إلى <RECEIVER NAME MASKED BY BANK> رقم مرجعي 885841387872 يوم 05-13 الساعة 23:17 للمزيد اتصل بـ 19623",
  // IP-NBE-4
  "تم خصم مبلغ 433.80 جم لحظيا باستخدام (شبكة المدفوعات اللحظية) من حسابكم رقم 0150 عند Home Internet يوم 05-02 الساعة11:42 مرجع التاجر 1215624709 للمزيد اتصل بـ 19623.",
  // IP-CIB-1, IP-CIB-1-D
  "يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 64500.00 جم إلى حسابك المنتهي بـ ********0018 من <SENDER NAME, Latin caps, cut: 23 chars> برقم مرجعي 9951576c بتاريخ 15-06-2025 22:49 للمزيد، برجاء الاتصال بـ 19666",
  "يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ 1000.00 جم من حسابك المنتهي بـ ****1065 برقم مرجعي 819a53fa بتاريخ 26-05-2026 19:35 للمزيد، برجاء الاتصال بـ 19666",
  // IP-QNB-1, IP-QNB-1-D, IP-QNB-PAIR-D
  "IPN transfer received with amount of EGP 500.00 on 5597 on 06/05 at 08:34 PM. Ref# ff961e35. For more details call 19700.",
  "IPN transfer sent with amount of EGP 100.00 from 5597 on 07/05 at 09:16 PM. Ref# e8819e2c. For more details call 19700.",
  "IPN transfer sent with amount of EGP 350.00 from 0694 on 18/09 at 07:32 AM. Ref# 43f3ef2a. For more details call 19700",
  // IP-BDC-1
  "تم إستقبال تحويل لحظي إلى حسابكم 4113 بمبلغ 350.00 جم من <SENDER NAME, Latin caps, 30 chars> في 07:32 يوم 9/18/26 رقم المعاملة 43f3ef2a للمزيد أتصل ب 16990",
  // IP-UNK-1
  "تم اضافة مبلغ 20000EGP الى حساب رقم xxx6201 فى 19-AUG-2026 عن طريق التحويل اللحظي",
  // IP-ADIB-1
  "Your account ending in 9596 has been charged the amount of 500.5 for an IPN transfer on 2026-08-18 17:56 Txn Ref: 1be731da For further details please call 19951",
];

/** = CANDIDATE_KEYWORDS (06 §4.9), copied verbatim. */
export const INTERIM_CANDIDATE_KEYWORDS = {
  ar: ["استلام", "إستلام", "استقبال", "إستقبال", "إضافة", "اضافة", "إيداع", "ايداع", "تحويل لحظي", "تم تحويل"],
  en: ["received", "credited", "IPN", "cash-in"],
} as const;

/** = the union of every template's footerDomains (06 §4.10 table). */
export const INTERIM_FOOTER_DOMAINS: readonly string[] = ["vf.eg", "spr.ly", "myo.orange.eg"];

/**
 * Every word of every fixture `fills` replacement (06 §4.14) plus the
 * synthetic words of §4.10.2. R5 (spec 15 §8): these are synthetic NAMES, so
 * they are never vocabulary, even when a published text happens to contain
 * the same spelling (e.g. the preposition "على" folds to the name "علي").
 */
export const INTERIM_FILL_NAMES: readonly string[] = [
  "محمد", "احمد", "علي", "عبد", "الرحمن", "محمود", "حسن",
  "AHMED", "MOHAMED", "ABDELRAHMAN", "MAHMOUD", "SAYED", "ABDELRAHM", "SAID", "ABDELAZEEZ", "ALI", "HASSAN",
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
  for (const text of INTERIM_PUBLISHED_SAMPLES) for (const w of wordsOf(text)) add(w);
  for (const w of [...INTERIM_CANDIDATE_KEYWORDS.ar, ...INTERIM_CANDIDATE_KEYWORDS.en]) {
    add(w);
    for (const part of w.split(/\s+/)) add(part);
  }
  for (const w of STATIC_WORDS) add(w);
  if (extra) for (const w of extra) add(w);
  for (const name of INTERIM_FILL_NAMES) vocab.delete(vocabKey(name));
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

const AR_FILLS = ["محمد", "احمد", "علي", "محمود", "حسن"];
const LATIN_FILLS = ["AHMED", "MOHAMED", "ALI", "MAHMOUD", "HASSAN"];
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
    if (hostAllowed(urlHost(url), INTERIM_FOOTER_DOMAINS)) return protect(url) + rest;
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

/**
 * = 06's applyFills (__fixtures__/samples.ts, order 18) — INTERIM. Replaces
 * every occurrence of each placeholder, in order; throws when one is absent.
 */
export function applyFillsLocal(published: string, fills: ReadonlyArray<readonly [string, string]>): string {
  let out = published;
  for (const [ph, rep] of fills) {
    if (!out.includes(ph)) throw new Error(`applyFills: placeholder ${JSON.stringify(ph)} is absent`);
    out = out.split(ph).join(rep);
  }
  return out;
}
