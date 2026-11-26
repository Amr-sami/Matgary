import type { Locale } from "./responses";
export type { Locale };

/**
 * F7 — Multilingual language detection + lock for the AI agent.
 *
 * Supported locales: ar, en, pt, fr, es. Policy:
 *  - Detect from the LAST user message in the conversation (not the first).
 *    This lets the owner switch mid-chat; a bilingual request stays in the
 *    dominant language of that message.
 *  - A hard directive is injected every round; re-asserted on round 2+ so
 *    English-heavy tool JSON cannot nudge the model out of the locked locale.
 *  - A post-generation sanity check logs a warning when the model's reply
 *    drifts off-lock. The UI still renders the response — we don't silently
 *    rewrite; that would mask the regression.
 *
 * Strategy:
 *   • Arabic script count wins if non-trivial → "ar".
 *   • Else count Latin-only accent chars + a small, carefully chosen list of
 *     language-specific function words (quanto / combien / cuánto / how /
 *     etc.). The language with the highest weighted score wins.
 *   • Short / numeric / emoji-only messages return "unknown" so the caller
 *     falls back to the previous turn's lock.
 *
 * Adding a locale: extend `LOCALES`, add an entry to `LATIN_SIGNATURES`,
 * add a directive in `localeDirective`, and add dictionary strings in
 * lib/ai/i18n.ts.
 */

export const LOCALES: readonly Locale[] = ["ar", "en", "pt", "fr", "es"] as const;

/* Unicode script ranges. */
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]/g;

function scriptCounts(text: string): { ar: number; latin: number } {
  return {
    ar: (text.match(ARABIC_RE) ?? []).length,
    latin: (text.match(LATIN_RE) ?? []).length,
  };
}

/**
 * Signature for each Latin-script locale: chars + weighted keywords.
 *
 * Keyword choice principle: each entry is a HIGH-SIGNAL function word or
 * closed-class token that is rare across the other supported languages —
 * "combien" and "aujourd'hui" scream French; "cuánto" screams Spanish;
 * "quanto" + "você" or "estoque" screams Portuguese. We avoid open-class
 * words (nouns) because a product name in another language could trip
 * the scorer.
 *
 * Weighting: each keyword counts as 2 points vs 1 for each accent/diacritic.
 * Ties on score + no distinctive signal → fall back to English.
 */
interface Signature {
  locale: "en" | "pt" | "fr" | "es";
  accents: RegExp; // characters distinctive to this locale (vs ASCII English)
  tokens: string[]; // word-boundary matched tokens, lowercase
}

const LATIN_SIGNATURES: Signature[] = [
  {
    locale: "en",
    accents: /[]/, // ASCII — no accents; English wins only if no other locale scored
    tokens: [
      "the",
      "and",
      "how",
      "what",
      "which",
      "where",
      "today",
      "price",
      "stock",
      "sales",
      "yesterday",
      "please",
      "change",
      "yes",
      "no",
      "okay",
      "ok",
    ],
  },
  {
    locale: "pt",
    accents: /[ãõáâàéêíóôúçÃÕÁÂÀÉÊÍÓÔÚÇ]/g,
    tokens: [
      "você",
      "voce",
      "quanto",
      "quantos",
      "quantas",
      "estoque",
      "preço",
      "preco",
      "vendas",
      "hoje",
      "ontem",
      "mude",
      "mudar",
      "mostre",
      "mostrar",
      "qual",
      "quais",
      "sim",
      "não",
      "nao",
      "dele",
      "dela",
      "obrigado",
      "obrigada",
    ],
  },
  {
    locale: "fr",
    accents: /[àâçéèêëîïôùûüÿœæÀÂÇÉÈÊËÎÏÔÙÛÜŸŒÆ]/g,
    tokens: [
      "combien",
      "aujourd",
      "quel",
      "quelle",
      "quels",
      "quelles",
      "prix",
      "stock",
      "ventes",
      "hier",
      "changez",
      "montrer",
      "montrez",
      "pouvez",
      "oui",
      "non",
      "merci",
      "bonjour",
      "comment",
      "nous",
      "vous",
      "son",
      "sa",
      "ses",
    ],
  },
  {
    locale: "es",
    accents: /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/g,
    tokens: [
      "cuánto",
      "cuanto",
      "cuántos",
      "cuantos",
      "cuántas",
      "cuantas",
      "cuál",
      "cual",
      "qué",
      "que",
      "cómo",
      "como",
      "hoy",
      "ayer",
      "ventas",
      "precio",
      "inventario",
      "cambia",
      "cambiar",
      "muéstrame",
      "muestrame",
      "sí",
      "no",
      "gracias",
      "por favor",
      "él",
      "ella",
    ],
  },
];

function countMatches(re: RegExp, text: string): number {
  if (!re.source || re.source === "(?:)") return 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

function tokenHits(text: string, tokens: string[]): number {
  // Word-boundary at Latin letters only; Arabic text is pre-filtered out.
  const lowered = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const tok of tokens) {
    // Allow apostrophe / hyphen as a "right edge" for "aujourd'hui"-style
    // partial matches on "aujourd".
    const re = new RegExp(
      `(?:^|[^a-zà-ÿœæ])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-zà-ÿœæ])`,
      "i",
    );
    if (re.test(lowered)) hits++;
  }
  return hits;
}

/**
 * Score every Latin-script candidate against the message. Highest-score
 * locale wins; a zero-everywhere score falls back to English (safe default).
 */
function classifyLatin(text: string): Locale {
  let bestLocale: Locale = "en";
  let bestScore = -1;
  for (const sig of LATIN_SIGNATURES) {
    const accents = countMatches(sig.accents, text);
    const tokens = tokenHits(text, sig.tokens);
    // Tokens score higher than accents — "quanto" is a stronger signal than
    // a single é that could be noise in a brand name.
    const score = tokens * 2 + accents;
    if (score > bestScore) {
      bestScore = score;
      bestLocale = sig.locale;
    }
  }
  return bestLocale;
}

/**
 * Classify a single piece of text as a locale or "unknown". Empty / neutral /
 * digits-only inputs resolve to `unknown` so the caller falls back to a
 * previous turn's lock.
 */
export function classifyText(text: string): Locale | "unknown" {
  if (!text) return "unknown";
  const { ar, latin } = scriptCounts(text);
  // Script-neutral messages (digits / punctuation / emoji only).
  if (ar === 0 && latin === 0) return "unknown";
  // Ambiguous tie — too little text in either script to decide. Caller falls
  // back to the previous turn's lock (or the overall fallback).
  if (ar > 0 && latin > 0 && ar === latin && ar < 3) return "unknown";
  // Arabic dominates when it carries the message, even if a single Latin
  // brand/SKU is embedded (e.g. "سعر Musk Rumman كام؟"). Threshold: Arabic
  // chars must at least match Latin chars to win — handles "ده Musk" edge.
  if (ar > 0 && ar >= Math.max(3, Math.floor(latin / 2))) return "ar";
  // Pure-Latin — disambiguate between en/pt/fr/es.
  if (latin > 0 && ar === 0) return classifyLatin(text);
  // Mixed with more Latin than Arabic — treat as Latin and disambiguate.
  if (latin > ar) return classifyLatin(text);
  // Light Arabic (1-2 chars) with lots of Latin — fall through to Latin.
  return classifyLatin(text);
}

export interface DetectInput {
  role: "user" | "assistant" | "model" | "system";
  content: string;
}

/**
 * Resolve the locale for the current round. Walks the conversation backward
 * from the newest user message, taking the first confident classification.
 * Falls back to Arabic (the shop-owner default) when every user turn is
 * script-neutral (digits / emoji / URLs).
 */
export function detectLocale(messages: DetectInput[], fallback: Locale = "ar"): Locale {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = classifyText(m.content);
    if (c !== "unknown") return c;
  }
  return fallback;
}

/**
 * Verify the model's reply is in the locked locale. We only check script-
 * GROUP matches (Arabic vs Latin) — telling French from Spanish from a 40-
 * word reply is unreliable, and silently rewriting would mask regressions.
 * Returns true for script-neutral content (short numeric/currency answers).
 */
export function replyMatchesLocale(text: string, locked: Locale): boolean {
  if (!text) return true;
  const { ar, latin } = scriptCounts(text);
  if (ar === 0 && latin === 0) return true;
  const inArabic = locked === "ar";
  const replyArabic = ar >= latin;
  return inArabic === replyArabic;
}

/**
 * The hard directive injected into every round's system message. One source
 * of truth so per-locale copy never drifts. Prepended on round 1 and
 * re-asserted on rounds 2+ when tool-JSON (English keys, ASCII numbers) has
 * had the most opportunity to drag the model into English.
 */
export function localeDirective(locale: Locale): string {
  switch (locale) {
    case "ar":
      return [
        "اللغة المفروضة لهذا الرد: العربية.",
        "كل كلمة يراها صاحب المتجر لازم تكون عربية — بما في ذلك عناوين الرسوم البيانية وأعمدة الجداول ومسمّيات الـ KPI ورسائل الخطأ وتأكيد العمليات.",
        "ممنوع الرد بالإنجليزية. أسماء العلامات التجارية والـ SKU وأرقام الهواتف تبقى كما هي.",
      ].join("\n");
    case "pt":
      return [
        "Idioma obrigatório desta resposta: Português.",
        "Tudo que o dono da loja vê precisa estar em português — títulos de gráficos, cabeçalhos de tabela, rótulos de KPI, erros, confirmações.",
        "Não responda em inglês. Nomes de marca, SKU e números de telefone permanecem como estão.",
      ].join("\n");
    case "fr":
      return [
        "Langue imposée pour cette réponse : français.",
        "Tout ce que voit le gérant doit être en français — titres de graphiques, en-têtes de tableaux, étiquettes de KPI, erreurs, confirmations.",
        "Ne répondez pas en anglais. Les noms de marque, SKU et numéros de téléphone restent inchangés.",
      ].join("\n");
    case "es":
      return [
        "Idioma obligatorio de esta respuesta: Español.",
        "Todo lo que ve el dueño de la tienda debe estar en español — títulos de gráficos, encabezados de tabla, etiquetas de KPI, errores, confirmaciones.",
        "No respondas en inglés. Los nombres de marca, SKU y números de teléfono quedan igual.",
      ].join("\n");
    case "en":
    default:
      return [
        "Locked response language: English.",
        "Every string the shop owner sees must be English — chart titles, table headers, KPI labels, errors, confirmations.",
        "Do not reply in Arabic. Brand names, SKUs and phone numbers stay as-is.",
      ].join("\n");
  }
}
