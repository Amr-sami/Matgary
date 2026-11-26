import { normalizeArabic, normalizeDigits } from "../normalize";

import {
  CONTEXT_REFERENCE_STALE_TURNS,
  type ConversationContext,
  type EntityReference,
} from "./types";

/**
 * F6 — Reference resolver.
 *
 * Given the latest user utterance and the current conversation context,
 * decide whether they're pointing at a previously-discussed entity.
 *
 * Three possible outcomes:
 *   • RESOLVED — one entity (HIGH confidence). Agent may proceed; the
 *     caller STILL has to run it through the F5 preview/confirmation path
 *     before any write (context never bypasses confirmation).
 *   • AMBIGUOUS — multiple plausible targets. Agent is told to ask.
 *   • UNRESOLVED — no reference pattern detected OR no matching state.
 *     Agent proceeds without a hint; grounding still protects writes.
 *
 * SAFETY RULES the resolver enforces:
 *   1. References older than CONTEXT_REFERENCE_STALE_TURNS are treated as
 *      stale — resolver returns UNRESOLVED and asks the agent to re-query.
 *   2. Pronoun references ("it") REQUIRE a selectedEntity; falling back to
 *      "most recent candidate" would silently guess and is rejected.
 *   3. Positional references ("second one") REQUIRE a candidate set and an
 *      index within range.
 */

export type ResolveResult =
  | { kind: "resolved"; entity: EntityReference; reason: string }
  | { kind: "ambiguous"; candidates: EntityReference[]; reason: string }
  | { kind: "unresolved"; reason: string };

export interface ResolveInput {
  /** User's latest raw message. */
  userText: string;
  /** Live conversation context. */
  context: ConversationContext;
  /** Legacy — Storo has no branch feature. Accepted for compatibility with
   *  existing call sites; always null at runtime. */
  currentBranchId?: string | null;
}

export function resolveReference(input: ResolveInput): ResolveResult {
  const { userText, context } = input;
  void input.currentBranchId;
  const normalized = normalizeForMatch(userText);

  // ─── Positional reference ("second one", "التاني") ────────────────────
  const positional = detectPositional(normalized, userText);
  if (positional !== null) {
    if (!context.lastCandidateSet || context.lastCandidateSet.candidates.length === 0) {
      return { kind: "unresolved", reason: "positional_but_no_candidate_set" };
    }
    if (isStale(context.lastCandidateSet.turnId, context.turnCount)) {
      return { kind: "unresolved", reason: "candidate_set_stale" };
    }
    const idx = positional === "last" ? context.lastCandidateSet.candidates.length - 1 : positional - 1;
    const candidate = context.lastCandidateSet.candidates[idx];
    if (!candidate) {
      return { kind: "unresolved", reason: "positional_out_of_range" };
    }
    return { kind: "resolved", entity: candidate, reason: `positional:${positional}` };
  }

  // ─── Pronoun reference ("it", "ده", "منه", "سعره") ────────────────────
  if (detectsPronoun(normalized, userText)) {
    // We need a clear "selected" entity. A candidate set alone is NOT enough —
    // "its price" with 3 candidates would be guesswork.
    if (context.selectedEntity) {
      if (isStale(context.selectedEntity.turnId, context.turnCount)) {
        return { kind: "unresolved", reason: "selected_stale" };
      }
      return { kind: "resolved", entity: context.selectedEntity, reason: "pronoun:selected" };
    }
    if (context.lastCandidateSet && context.lastCandidateSet.candidates.length === 1) {
      // Only one candidate on the last turn → pronoun maps to it unambiguously.
      const only = context.lastCandidateSet.candidates[0]!;
      if (isStale(context.lastCandidateSet.turnId, context.turnCount)) {
        return { kind: "unresolved", reason: "only_candidate_stale" };
      }
      return { kind: "resolved", entity: only, reason: "pronoun:only_candidate" };
    }
    if (context.lastCandidateSet && context.lastCandidateSet.candidates.length > 1) {
      // Ambiguous — multiple candidates visible, user said "it". Ask.
      return {
        kind: "ambiguous",
        candidates: context.lastCandidateSet.candidates,
        reason: "pronoun:ambiguous_candidate_set",
      };
    }
    return { kind: "unresolved", reason: "pronoun_but_no_context" };
  }

  return { kind: "unresolved", reason: "no_reference_pattern" };
}

/* ───────────────────────── pattern detection ──────────────────────────── */

/** Latin ordinals + Arabic ordinals + bare digit forms. Returns the 1-based
 *  index the user named, or "last", or null if nothing positional matched.
 *
 *  F7: added Portuguese / French / Spanish ordinals (first..tenth) in
 *  masculine + feminine forms. "último/última", "dernier/dernière",
 *  "último/última" capture the "last" slot. */
function detectPositional(norm: string, raw: string): number | "last" | null {
  // Explicit "last" markers (en / pt / fr / es). JS `\b` is ASCII-only, so
  // accented words like "último" / "dernière" need Unicode-aware boundaries.
  if (uniWord(norm, /(last|final|ultimo|ultima|último|última|dernier|derniere|dernière)/u))
    return "last";
  if (/الاخير|الأخير/.test(raw)) return "last";

  // English + Romance ordinals. Overlapping entries (e.g. "second" matches
  // only EN) are harmless because each language's forms are distinct.
  const latinOrdinal: Record<string, number> = {
    // English
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    // Portuguese (masculine + feminine)
    primeiro: 1, primeira: 1,
    segundo: 2, segunda: 2,
    terceiro: 3, terceira: 3,
    quarto: 4, quarta: 4,
    quinto: 5, quinta: 5,
    sexto: 6, sexta: 6,
    setimo: 7, "sétimo": 7, "sétima": 7, setima: 7,
    oitavo: 8, oitava: 8,
    nono: 9, nona: 9,
    decimo: 10, "décimo": 10, "décima": 10, decima: 10,
    // French
    premier: 1, premiere: 1, "première": 1,
    deuxieme: 2, "deuxième": 2, second_fr: 2, seconde: 2,
    troisieme: 3, "troisième": 3,
    quatrieme: 4, "quatrième": 4,
    cinquieme: 5, "cinquième": 5,
    sixieme: 6, "sixième": 6,
    septieme: 7, "septième": 7,
    huitieme: 8, "huitième": 8,
    neuvieme: 9, "neuvième": 9,
    dixieme: 10, "dixième": 10,
    // Spanish
    primero: 1, primera: 1,
    // 'segundo' already above (shared with PT)
    tercero: 3, tercera: 3, tercer: 3,
    cuarto: 4, cuarta: 4,
    quinta_es: 5,
    sexto_es: 6,
    septimo: 7, "séptimo": 7, "séptima": 7,
    octavo: 8, octava: 8,
    noveno: 9, novena: 9,
    decimo_es: 10,
  };
  for (const [word, n] of Object.entries(latinOrdinal)) {
    // Strip the disambiguation suffix we used for shared-form keys.
    const token = word.replace(/_fr$|_es$/, "");
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Unicode-aware boundary — `\b` is ASCII-only and would miss "último".
    if (uniWord(norm, new RegExp(escaped, "iu"))) return n;
  }
  // "the 2nd", "the 3rd", "el 2", "o 2º" style.
  const num = /\b(?:the\s+|el\s+|la\s+|o\s+|a\s+|le\s+)?(\d{1,2})(?:st|nd|rd|th|º|ª|e|e̊)?\b/i.exec(
    norm,
  );
  if (
    num &&
    /\b(?:one|product|item|option|result|candidate|produto|producto|produit|artigo|artículo|article)\b/i.test(
      norm,
    )
  ) {
    const n = Number(num[1]);
    if (n >= 1 && n <= 20) return n;
  }

  // Arabic ordinals — normalised Arabic form (alif variants collapsed by
  // normalizeArabic in normalizeForMatch).
  const arabicOrdinal: Array<{ re: RegExp; n: number }> = [
    { re: /الاول|الأول|اول/, n: 1 },
    { re: /الثاني|الثانيه|التاني|التانيه|ثاني|تاني/, n: 2 },
    { re: /الثالث|الثالثه|التالت|التالته|ثالث|تالت/, n: 3 },
    { re: /الرابع|الرابعه|رابع/, n: 4 },
    { re: /الخامس|الخامسه|خامس/, n: 5 },
    { re: /السادس|السادسه|سادس/, n: 6 },
    { re: /السابع|السابعه|سابع/, n: 7 },
    { re: /الثامن|الثامنه|ثامن/, n: 8 },
    { re: /التاسع|التاسعه|تاسع/, n: 9 },
    { re: /العاشر|العاشره|عاشر/, n: 10 },
  ];
  // Apply Arabic normalization (collapse alif/yaa/haa/tashkeel) then test.
  const arNorm = normalizeArabic(raw);
  for (const { re, n } of arabicOrdinal) {
    if (re.test(arNorm)) return n;
  }
  // "التاني منهم", "التاني ده", etc. — already covered by the stem patterns.

  return null;
}

/** True if the user's utterance leans on a pronoun / "it" reference that
 *  should pull from selectedEntity. Conservative — favour UNRESOLVED over
 *  guessing.
 *
 *  F7: added Portuguese / French / Spanish pronoun patterns. Each language
 *  marks "its X" / "his X" / "change it" differently; we encode the common
 *  shopping-command forms the shop owner actually types. */
function detectsPronoun(norm: string, raw: string): boolean {
  // English pronouns in a context likely referring to a product.
  if (/\b(it|its|that|this)\s+(one|product|price|quantity|stock|cost|customer|brand|item)\b/.test(norm)) return true;
  if (/\bits\s+(price|quantity|stock|cost)\b/.test(norm)) return true;
  if (/\b(the|that)\s+(same|previous)\b/.test(norm)) return true;
  if (/\bchange\s+it\b/.test(norm)) return true;
  if (/\bmake\s+it\b/.test(norm)) return true;
  if (/\bset\s+it\b/.test(norm)) return true;

  // Portuguese — "seu preço" / "sua quantidade" / "mude seu preço",
  // "o preço dele" / "o estoque dele" (3rd-person clitic "dele/dela").
  if (/\b(seu|sua)\s+(preço|preco|quantidade|estoque|custo)\b/.test(norm)) return true;
  if (/\b(o|a)\s+(preço|preco|quantidade|estoque|custo)\s+(dele|dela)\b/.test(norm)) return true;
  if (/\bmude\s+(seu|sua|o|a)\b/.test(norm)) return true;
  if (/\b(mostre|mostrar|ver)\s+(seu|sua|o|a).{0,20}\b(dele|dela)\b/.test(norm)) return true;
  if (/\besse\s+(produto|item)\b/.test(norm)) return true;

  // French — "son prix" / "sa quantité" / "changez son prix", "le/la même".
  if (/\b(son|sa|ses)\s+(prix|quantité|quantite|stock|coût|cout)\b/.test(norm)) return true;
  if (/\b(le|la)\s+(même|meme)\b/.test(norm)) return true;
  if (/\bchangez(-|\s)?(le|la|son|sa)\b/.test(norm)) return true;
  if (/\bmettez(-|\s)?le\b/.test(norm)) return true;
  if (/\bce\s+(produit|article)\b/.test(norm)) return true;

  // Spanish — "su precio" / "su cantidad" / "cambia su precio".
  if (/\bsu\s+(precio|cantidad|stock|inventario|costo)\b/.test(norm)) return true;
  if (/\bel\s+(mismo|precio\s+de\s+él)\b/.test(norm)) return true;
  if (/\bcambia(lo|la)?\s+(su|a|el)\b/.test(norm)) return true;
  if (/\bponlo\b|\bponla\b|\bhazlo\b|\bhazla\b/.test(norm)) return true;
  if (/\beste\s+(producto|artículo|articulo)\b/.test(norm)) return true;

  // Arabic pronouns / clitics. Work on the Arabic-normalised form so alif
  // variants / yaa / haa don't matter.
  const arNorm = normalizeArabic(raw);
  // "ده" / "دي" / "ده المنتج" / "المنتج ده" — strong product-reference hint.
  // Can't use \b (JS word boundary is ASCII-only). Use a non-word char / edge.
  if (/(^|[^؀-ۿ])ده($|[^؀-ۿ])|(^|[^؀-ۿ])دي($|[^؀-ۿ])/.test(arNorm)) return true;
  // Clitic -ه/-ها on common attribute nouns (سعره, كميته, كودها, …).
  if (/سعره|سعرها|كميته|كميتها|كوده|كودها|اسمه|اسمها|بتاعه|بتاعها|فيه|فيها|منه|منها/.test(arNorm)) return true;
  // "هو" / "هي" standalone as a subject. Same non-Arabic-boundary pattern.
  if (/(^|[^؀-ۿ])هو($|[^؀-ۿ])|(^|[^؀-ۿ])هي($|[^؀-ۿ])/.test(arNorm)) return true;
  // "نفس المنتج", "المنتج نفسه", "المنتج السابق"
  if (/نفس\s*المنتج|المنتج\s*نفسه|المنتج\s*السابق/.test(arNorm)) return true;

  return false;
}

/* ───────────────────────── scope guards ───────────────────────────────── */

function isStale(capturedTurnId: number, nowTurnId: number): boolean {
  return nowTurnId - capturedTurnId > CONTEXT_REFERENCE_STALE_TURNS;
}

function normalizeForMatch(s: string): string {
  // Lowercase + Arabic-indic digits → ASCII + collapse whitespace.
  return normalizeDigits(s.toLowerCase().replace(/\s+/g, " ").trim());
}

/**
 * Unicode-aware word test. JS `\b` only considers `[A-Za-z0-9_]` as "word"
 * chars, so accented Latin words like "último" or "dernière" break ASCII
 * boundary matching. This helper surrounds the pattern with non-letter
 * boundaries using Unicode property escapes.
 */
function uniWord(hay: string, pat: RegExp): boolean {
  const body = pat.source;
  const re = new RegExp(`(^|[^\\p{L}])(?:${body})(?=$|[^\\p{L}])`, "iu");
  return re.test(hay);
}
