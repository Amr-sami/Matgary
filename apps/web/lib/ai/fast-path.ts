import type { Locale } from "./language";

/**
 * F11 — Trivial-greeting fast path.
 *
 * Purpose:
 *   • Fixes the ~20-second latency on pure social messages ("Hi", "مرحبا",
 *     "Hola", …) by short-circuiting the full agent loop.
 *   • Guarantees ONE text block for these turns — the model has no chance
 *     to over-chat into multiple render_text calls.
 *
 * What counts as trivial:
 *   • Pure greeting token: "hi", "hello", "hey", "yo", "salam", …
 *   • Pure thanks: "thanks", "thank you", "شكرا", "merci", …
 *   • Pure acknowledgement: "ok", "okay", "تمام", …
 *   • Nothing else — a message with a question mark or any domain-specific
 *     keyword (product, sales, …) is NOT trivial and MUST go through the
 *     normal agent.
 *
 * Safety:
 *   • Pure function; no DB, no provider, no I/O.
 *   • Takes the LAST user message and the locked locale. No LLM anywhere.
 *   • A response is a single short text block in the locked locale.
 *   • Returns `null` when the input isn't a trivial match — the agent then
 *     proceeds normally.
 *
 * Internationalisation:
 *   • Token lists per locale. The CHECK is permissive — any supported-locale
 *     greeting triggers fast-path regardless of the locked locale (so a
 *     user who switched between messages still sees a sensible short reply).
 *   • The REPLY is generated in the locked locale so the per-turn locale
 *     rule holds.
 */

/** Short greeting/thanks/ack tokens across the five supported locales. The
 *  check lowercases + strips punctuation + whitespace before comparing. */
const TRIVIAL_TOKENS: Record<"greet" | "thanks" | "ack", string[]> = {
  greet: [
    // English
    "hi", "hello", "hey", "yo", "hiya", "heya", "howdy",
    // Arabic (and Arabic-ish transliterations commonly typed in dev chats)
    "مرحبا", "مرحبًا", "اهلا", "أهلا", "اهلاً", "أهلاً", "السلام عليكم",
    "سلام", "هاي", "هلا", "ياهلا", "صباح الخير", "مساء الخير",
    // Portuguese
    "oi", "olá", "ola", "ei",
    // French
    "salut", "bonjour", "coucou", "bonsoir",
    // Spanish
    "hola", "buenas", "buenos días", "buenas tardes", "qué tal",
  ],
  thanks: [
    "thanks", "thank you", "thx", "ty", "cheers",
    "شكرا", "شكرًا", "شكراً", "ممنون", "متشكر",
    "obrigado", "obrigada", "valeu",
    "merci", "merci beaucoup",
    "gracias", "muchas gracias",
  ],
  ack: [
    "ok", "okay", "k", "got it", "sure", "alright", "cool",
    "تمام", "حاضر", "ماشي", "اوك",
    "ta bom", "beleza",
    "d'accord", "ok",
    "vale", "bueno",
  ],
};

/** Canned short replies per locale. Deliberately warm, deliberately short. */
const REPLIES: Record<
  "greet" | "thanks" | "ack",
  Record<Locale, string>
> = {
  greet: {
    en: "Hi! How can I help with your store today?",
    ar: "أهلاً! كيف أقدر أساعدك في متجرك النهاردة؟",
    pt: "Olá! Como posso ajudar com a sua loja hoje?",
    fr: "Bonjour ! Comment puis-je vous aider avec votre magasin aujourd'hui ?",
    es: "¡Hola! ¿Cómo puedo ayudarte con tu tienda hoy?",
  },
  thanks: {
    en: "You're welcome!",
    ar: "العفو!",
    pt: "De nada!",
    fr: "Je vous en prie !",
    es: "¡De nada!",
  },
  ack: {
    en: "Got it. Let me know if there's anything else.",
    ar: "تمام. قولي لو محتاج أي حاجة تانية.",
    pt: "Entendido. Me avise se precisar de mais algo.",
    fr: "Compris. Dites-moi si vous avez besoin d'autre chose.",
    es: "Entendido. Avísame si necesitas algo más.",
  },
};

/** Characters we strip before token comparison so "Hi!!" and "hi " both
 *  normalise to the same token. We keep letters (incl. Arabic) + spaces.
 *  Also collapses 3+ consecutive identical characters to one so Egyptian
 *  colloquial elongations like "هاااي" → "هاي", "heyyyyy" → "hey",
 *  "شكراااا" → "شكرا" all match the base token. */
function normalise(s: string): string {
  return s
    .trim()
    .toLowerCase()
    // Strip trailing/leading punctuation, emoji, exclamation, etc.
    .replace(/^[^\p{L}\s]+|[^\p{L}\s]+$/gu, "")
    .replace(/\s+/g, " ")
    // Collapse 3+ repeats of any character to a single instance. Chosen
    // conservatively — 2 repeats stay (English "hello" has "ll", Arabic
    // double-letter prefixes). The user's real-world case was "هاااي"
    // (4x alef), which collapses cleanly to "هاي".
    .replace(/(.)\1{2,}/gu, "$1")
    .trim();
}

/** Returns true when the text looks like a pure social token.
 *
 *  Length gate: we only match very short inputs. A longer message is domain
 *  content, not a greeting. The threshold is generous (40 chars) to cover
 *  "good morning" / "صباح الخير" plus trailing punctuation. */
function classifyTrivial(text: string): keyof typeof TRIVIAL_TOKENS | null {
  const normal = normalise(text);
  if (!normal) return null;
  if (normal.length > 40) return null;

  // Hard reject: anything with a question mark, digits, or obvious domain
  // vocabulary is NOT trivial. These are strict allowlist matches below,
  // but defence-in-depth helps when a user sends "hi, what are my sales?".
  const raw = text.toLowerCase();
  if (raw.includes("?") || /\d/.test(raw)) return null;
  const DOMAIN_WORDS = [
    "sale", "sales", "product", "supplier", "customer", "stock", "inventory",
    "import", "price", "quantity", "invoice", "order", "revenue", "profit",
    "مبيعات", "منتج", "مورد", "عميل", "مخزون", "استيراد", "سعر", "كمية", "فاتورة",
  ];
  if (DOMAIN_WORDS.some((w) => raw.includes(w))) return null;

  for (const [kind, tokens] of Object.entries(TRIVIAL_TOKENS) as Array<
    [keyof typeof TRIVIAL_TOKENS, string[]]
  >) {
    for (const t of tokens) {
      const nt = normalise(t);
      if (normal === nt) return kind;
      // Allow trivial-token + one trailing word: "hi there", "hello storo"
      if (normal === `${nt} there` || normal === `${nt} storo`) return kind;
    }
  }
  return null;
}

export interface TrivialFastPathHit {
  kind: "greet" | "thanks" | "ack";
  text: string;
}

/** Non-null when the latest user message is a trivial greeting / thanks /
 *  acknowledgement; null otherwise. */
export function tryTrivialFastPath(
  latestUserText: string,
  locale: Locale,
): TrivialFastPathHit | null {
  const kind = classifyTrivial(latestUserText);
  if (!kind) return null;
  return { kind, text: REPLIES[kind][locale] };
}
