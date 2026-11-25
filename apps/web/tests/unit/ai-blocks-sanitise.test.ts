/**
 * F11 — JSON-leak sanitiser regression tests.
 *
 * The user's screenshot showed raw JSON in a chat bubble. The agent's
 * fallback path previously wrapped the raw model content as-is whenever
 * salvage failed; `looksLikeStructuredLeak` + `sanitiseText` are the
 * server-side guard that prevents that from reaching the client.
 */
import { describe, expect, it } from "vitest";

import {
  looksLikeStructuredLeak,
  sanitiseText,
  sanitisedTextBlock,
} from "@/lib/ai/blocks/sanitise";

describe("looksLikeStructuredLeak", () => {
  it("rejects plain prose (English)", () => {
    expect(looksLikeStructuredLeak("Diamond Sakura is 2200 EGP, 5 in stock.")).toBe(false);
  });

  it("rejects plain prose (Arabic)", () => {
    expect(looksLikeStructuredLeak("سعر برفان دايموند ساكورا هو 2200 جنيه.")).toBe(false);
  });

  it("flags leaked render_text JSON", () => {
    expect(
      looksLikeStructuredLeak('{"name":"render_text","arguments":{"text":"hi"}}'),
    ).toBe(true);
  });

  it("flags leaked render_warning JSON (regression — was outside salvage allowlist)", () => {
    expect(
      looksLikeStructuredLeak(
        '{"name":"render_warning","arguments":{"title":"heads up","message":"xyz","code":"X","severity":"warning"}}',
      ),
    ).toBe(true);
  });

  it("flags leaked block JSON by kind field", () => {
    expect(
      looksLikeStructuredLeak(
        '{"kind":"product_card","productId":"p1","name":"Diamond Sakura"}',
      ),
    ).toBe(true);
  });

  it("flags leaked block JSON wrapped in an array", () => {
    expect(
      looksLikeStructuredLeak(
        '[{"kind":"product_card","productId":"p1","name":"X"}]',
      ),
    ).toBe(true);
  });

  it("flags function-call shaped text", () => {
    expect(looksLikeStructuredLeak('render_text({"text":"hi"})')).toBe(true);
    expect(
      looksLikeStructuredLeak(
        'preview_update_product_price(product_id="p1", new_price=200)',
      ),
    ).toBe(true);
  });

  it("flags a tool_calls payload", () => {
    expect(
      looksLikeStructuredLeak('{"tool_calls":[{"name":"render_text"}]}'),
    ).toBe(true);
  });

  it("flags editable_import_preview leak", () => {
    expect(
      looksLikeStructuredLeak(
        '{"kind":"editable_import_preview","sessionId":"abc","rows":[]}',
      ),
    ).toBe(true);
  });

  it("does NOT flag prose that merely mentions render_text as a word", () => {
    // Prose without JSON shape — no `{`/`}`/`(`.
    expect(
      looksLikeStructuredLeak(
        "If you say render text I will show more detail about the product.",
      ),
    ).toBe(false);
  });

  it("does NOT flag JSON-ish Arabic prose with legitimate curly brackets", () => {
    // Quoted hint-text that contains `{file}` placeholder (no JSON shape).
    expect(looksLikeStructuredLeak("استيراد الملف {file}")).toBe(false);
  });

  it("empty / whitespace input returns false", () => {
    expect(looksLikeStructuredLeak("")).toBe(false);
    expect(looksLikeStructuredLeak("   \n  \t  ")).toBe(false);
  });
});

describe("sanitiseText", () => {
  it("passes prose through unchanged", () => {
    const text = "Diamond Sakura price is 2200 EGP, 5 in stock.";
    expect(sanitiseText(text, "en")).toBe(text);
  });

  it("replaces leaked JSON with a safe localised nudge (EN)", () => {
    const out = sanitiseText(
      '{"name":"render_text","arguments":{"text":"hi"}}',
      "en",
    );
    expect(out).not.toContain('"name"');
    expect(out).not.toContain("render_text");
    expect(out.toLowerCase()).toContain("couldn't format");
  });

  it("replaces leaked JSON with a safe localised nudge (AR)", () => {
    const out = sanitiseText(
      '{"kind":"product_card","productId":"p1"}',
      "ar",
    );
    expect(out).not.toContain('"kind"');
    expect(out).not.toContain("product_card");
    // Arabic for "I couldn't format that response"
    expect(out).toContain("لم");
  });

  it("sanitisedTextBlock wraps the sanitised text", () => {
    const block = sanitisedTextBlock(
      '{"name":"render_warning","arguments":{"title":"hi"}}',
      "en",
    );
    expect(block.kind).toBe("text");
    expect(block.text).not.toContain('"name"');
  });
});
