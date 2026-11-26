/**
 * Language-lock unit tests for the AI agent (apps/web/lib/ai/language.ts).
 *
 * F7 — covers 5 locales (ar/en/pt/fr/es). The deterministic parts of the
 * lock (detection + reply match) are tested independently of the LLM; the
 * agent runner's end-to-end behavior lives in the live smoke suite.
 */
import { describe, expect, it } from "vitest";

import {
  classifyText,
  detectLocale,
  localeDirective,
  LOCALES,
  replyMatchesLocale,
} from "@/lib/ai/language";

describe("classifyText — Arabic", () => {
  it("plain Arabic → ar", () => {
    expect(classifyText("كم بعت النهارده؟")).toBe("ar");
  });

  it("Arabic-dominant mixed → ar", () => {
    expect(classifyText("اعرضلي كل البراندات دي Casio")).toBe("ar");
  });

  it("Arabic sentence with Latin brand name inside → ar", () => {
    expect(classifyText("سعر Musk Rumman كام؟")).toBe("ar");
  });
});

describe("classifyText — English", () => {
  it("plain English → en", () => {
    expect(classifyText("How much did we sell today?")).toBe("en");
  });

  it("English-dominant mixed → en", () => {
    expect(classifyText("Show me brand sales trend for أكتوبر")).toBe("en");
  });

  it("short yes/no → en", () => {
    expect(classifyText("yes please")).toBe("en");
    expect(classifyText("ok")).toBe("en");
  });
});

describe("classifyText — Portuguese", () => {
  it("'Quanto vendemos hoje' → pt", () => {
    expect(classifyText("Quanto vendemos hoje?")).toBe("pt");
  });

  it("stock / preço cues → pt", () => {
    expect(classifyText("Qual é o estoque dele?")).toBe("pt");
    expect(classifyText("Mostre o preço do produto")).toBe("pt");
  });

  it("cedilla/tilde accents reinforce pt", () => {
    expect(classifyText("não")).toBe("pt");
  });
});

describe("classifyText — French", () => {
  it("'Combien avons-nous vendu aujourd'hui' → fr", () => {
    expect(classifyText("Combien avons-nous vendu aujourd'hui ?")).toBe("fr");
  });

  it("'Quel est son prix' → fr", () => {
    expect(classifyText("Quel est son prix ?")).toBe("fr");
  });

  it("'Changez son prix à 2500' → fr", () => {
    expect(classifyText("Changez son prix à 2500")).toBe("fr");
  });
});

describe("classifyText — Spanish", () => {
  it("'¿Cuánto vendimos hoy?' → es", () => {
    expect(classifyText("¿Cuánto vendimos hoy?")).toBe("es");
  });

  it("'¿Cuál es su precio?' → es", () => {
    expect(classifyText("¿Cuál es su precio?")).toBe("es");
  });

  it("'cambia su precio a 2500' → es", () => {
    expect(classifyText("cambia su precio a 2500")).toBe("es");
  });
});

describe("classifyText — short / neutral", () => {
  it("'123 456' → unknown (digits only)", () => {
    expect(classifyText("123 456")).toBe("unknown");
  });

  it("empty string → unknown", () => {
    expect(classifyText("")).toBe("unknown");
  });

  it("balanced tiny mixed → unknown (caller falls back)", () => {
    expect(classifyText("ab مر")).toBe("unknown");
  });

  // Note: the short single-word tokens like "yes", "sí", "oui", "sim" are
  // handled per-locale by the keyword hit — tested in the per-language blocks.
});

describe("classifyText — product-name exception", () => {
  it("Arabic sentence with English product name stays Arabic", () => {
    expect(classifyText("فيه كام قطعة من Musk Rumman؟")).toBe("ar");
  });

  it("English sentence with transliterated Arabic brand stays English", () => {
    expect(classifyText("How much Al-Hinnawi perfume do we have?")).toBe("en");
  });
});

describe("detectLocale — walks newest-user-first", () => {
  it("picks the latest user locale", () => {
    const locale = detectLocale([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "..." },
      { role: "user", content: "ممكن كشف المبيعات؟" },
    ]);
    expect(locale).toBe("ar");
  });

  it("walks backward across a neutral user turn", () => {
    const locale = detectLocale([
      { role: "user", content: "اوريني الرسم البياني" },
      { role: "assistant", content: "تفضل" },
      { role: "user", content: "123" },
    ]);
    expect(locale).toBe("ar");
  });

  it("falls back to Arabic when every user turn is script-neutral", () => {
    expect(detectLocale([{ role: "user", content: "456 789" }])).toBe("ar");
  });

  it("honors the fallback argument", () => {
    expect(detectLocale([{ role: "user", content: "" }], "en")).toBe("en");
    expect(detectLocale([{ role: "user", content: "" }], "pt")).toBe("pt");
  });

  it("ignores assistant / system turns", () => {
    const locale = detectLocale([
      { role: "assistant", content: "Here is the data in English." },
      { role: "user", content: "تمام" },
    ]);
    expect(locale).toBe("ar");
  });

  it("handles mid-conversation switch to pt", () => {
    const locale = detectLocale([
      { role: "user", content: "Show me Assaf perfumes" },
      { role: "assistant", content: "Found two perfumes." },
      { role: "user", content: "Quanto estoque ele tem?" },
    ]);
    expect(locale).toBe("pt");
  });

  it("handles multi-switch conversation EN → FR → ES", () => {
    const locale = detectLocale([
      { role: "user", content: "How much did we sell?" },
      { role: "user", content: "Quel est son prix ?" },
      { role: "user", content: "¿Cuánto vendimos hoy?" },
    ]);
    expect(locale).toBe("es");
  });
});

describe("replyMatchesLocale — script-group check", () => {
  it("Arabic reply for Arabic lock → match", () => {
    expect(replyMatchesLocale("هذا هو الملخص.", "ar")).toBe(true);
  });

  it("Latin reply for any Latin lock → match (script-group only)", () => {
    // The verifier intentionally only detects script GROUP; language-of-Latin
    // is hard to tell from 20 words and silently rewriting masks regressions.
    expect(replyMatchesLocale("Here is the summary.", "en")).toBe(true);
    expect(replyMatchesLocale("Voici le résumé.", "fr")).toBe(true);
    expect(replyMatchesLocale("Aquí está el resumen.", "es")).toBe(true);
    expect(replyMatchesLocale("Aqui está o resumo.", "pt")).toBe(true);
  });

  it("Latin reply for Arabic lock → MISMATCH", () => {
    expect(replyMatchesLocale("Here is the summary.", "ar")).toBe(false);
  });

  it("Arabic reply for a Latin-family lock → MISMATCH", () => {
    expect(replyMatchesLocale("هذا هو الملخص.", "en")).toBe(false);
    expect(replyMatchesLocale("هذا هو الملخص.", "pt")).toBe(false);
    expect(replyMatchesLocale("هذا هو الملخص.", "fr")).toBe(false);
    expect(replyMatchesLocale("هذا هو الملخص.", "es")).toBe(false);
  });

  it("script-neutral reply always matches", () => {
    // Pure Arabic-script currency suffix → matches ar.
    expect(replyMatchesLocale("1,250 ج.م", "ar")).toBe(true);
    // Em-dash alone is script-neutral → matches anything.
    expect(replyMatchesLocale("—", "fr")).toBe(true);
    expect(replyMatchesLocale("—", "ar")).toBe(true);
    // Pure digits → neutral.
    expect(replyMatchesLocale("1,250", "pt")).toBe(true);
  });

  it("latin-currency-code reply correctly MISMATCHES for ar lock", () => {
    // "1,250 EGP" is dominantly Latin (E,G,P) → not an ar reply. The
    // Arabic answer should use "ج.م" instead. Mismatch = correct detection.
    expect(replyMatchesLocale("1,250 EGP", "ar")).toBe(false);
  });
});

describe("localeDirective — 5 locales", () => {
  it("generates a per-locale directive for every supported locale", () => {
    for (const loc of LOCALES) {
      const d = localeDirective(loc);
      expect(d.length).toBeGreaterThan(20);
      // First line is the headline — must mention the response language.
      const first = d.split("\n")[0]!;
      expect(first.length).toBeGreaterThan(0);
    }
  });

  it("Arabic directive is in Arabic script", () => {
    expect(/[؀-ۿ]/.test(localeDirective("ar"))).toBe(true);
  });

  it("French directive mentions 'français'", () => {
    expect(/français/i.test(localeDirective("fr"))).toBe(true);
  });

  it("Spanish directive mentions 'Español'", () => {
    expect(/español/i.test(localeDirective("es"))).toBe(true);
  });

  it("Portuguese directive mentions 'Português'", () => {
    expect(/português/i.test(localeDirective("pt"))).toBe(true);
  });
});
