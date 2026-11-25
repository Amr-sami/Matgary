/**
 * Trivial-greeting fast path — lock in the detection + reply rules.
 *
 * Purpose: short-circuit "Hi" / "thanks" / "ok" turns before the full
 * agent runs. Fixes the ~20s latency on those inputs and guarantees ONE
 * text block per turn.
 *
 * Safety: false positives would hide domain content, so the length +
 * domain-word gate is strict. These tests pin that strictness.
 */
import { describe, expect, it } from "vitest";

import { tryTrivialFastPath } from "@/lib/ai/fast-path";

describe("tryTrivialFastPath — true positives", () => {
  it("English greetings", () => {
    expect(tryTrivialFastPath("Hi", "en")?.kind).toBe("greet");
    expect(tryTrivialFastPath("hello", "en")?.kind).toBe("greet");
    expect(tryTrivialFastPath("Hey!", "en")?.kind).toBe("greet");
    expect(tryTrivialFastPath("  Hi there  ", "en")?.kind).toBe("greet");
  });

  it("Arabic greetings", () => {
    expect(tryTrivialFastPath("مرحبا", "ar")?.kind).toBe("greet");
    expect(tryTrivialFastPath("أهلاً", "ar")?.kind).toBe("greet");
    expect(tryTrivialFastPath("هاي", "ar")?.kind).toBe("greet");
    expect(tryTrivialFastPath("السلام عليكم", "ar")?.kind).toBe("greet");
  });

  it("Arabic colloquial elongations (real-world trace: هاااي)", () => {
    // Egyptian colloquial drags vowels/consonants. Normalise collapses
    // 3+ repeats to one: هاااي → هاي (base token).
    expect(tryTrivialFastPath("هاااي", "ar")?.kind).toBe("greet");
    expect(tryTrivialFastPath("هاااااي", "ar")?.kind).toBe("greet");
    expect(tryTrivialFastPath("heyyyyy", "en")?.kind).toBe("greet");
    expect(tryTrivialFastPath("شكراااا", "ar")?.kind).toBe("thanks");
  });

  it("PT/FR/ES greetings", () => {
    expect(tryTrivialFastPath("oi", "pt")?.kind).toBe("greet");
    expect(tryTrivialFastPath("salut", "fr")?.kind).toBe("greet");
    expect(tryTrivialFastPath("hola", "es")?.kind).toBe("greet");
  });

  it("thanks", () => {
    expect(tryTrivialFastPath("thanks", "en")?.kind).toBe("thanks");
    expect(tryTrivialFastPath("thank you", "en")?.kind).toBe("thanks");
    expect(tryTrivialFastPath("شكرا", "ar")?.kind).toBe("thanks");
    expect(tryTrivialFastPath("merci", "fr")?.kind).toBe("thanks");
  });

  it("acknowledgement", () => {
    expect(tryTrivialFastPath("ok", "en")?.kind).toBe("ack");
    expect(tryTrivialFastPath("okay", "en")?.kind).toBe("ack");
    expect(tryTrivialFastPath("Got it", "en")?.kind).toBe("ack");
    expect(tryTrivialFastPath("تمام", "ar")?.kind).toBe("ack");
  });

  it("returns a locale-matching reply", () => {
    expect(tryTrivialFastPath("Hi", "en")?.text).toContain("Hi!");
    expect(tryTrivialFastPath("Hi", "ar")?.text).toContain("أهلاً");
    expect(tryTrivialFastPath("Hi", "pt")?.text).toContain("Olá");
    expect(tryTrivialFastPath("thanks", "en")?.text).toBe("You're welcome!");
    expect(tryTrivialFastPath("شكرا", "ar")?.text).toBe("العفو!");
  });
});

describe("tryTrivialFastPath — false positives rejected", () => {
  it("any question → NOT trivial", () => {
    expect(tryTrivialFastPath("Hi, what are my sales?", "en")).toBeNull();
    expect(tryTrivialFastPath("مرحبا كيف المبيعات؟", "ar")).toBeNull();
    expect(tryTrivialFastPath("what's new?", "en")).toBeNull();
  });

  it("domain vocabulary → NOT trivial", () => {
    expect(tryTrivialFastPath("tell me about my suppliers", "en")).toBeNull();
    expect(tryTrivialFastPath("show products", "en")).toBeNull();
    expect(tryTrivialFastPath("مبيعات اليوم", "ar")).toBeNull();
    expect(tryTrivialFastPath("مين الموردين", "ar")).toBeNull();
  });

  it("digits in message → NOT trivial", () => {
    expect(tryTrivialFastPath("hi 2 you", "en")).toBeNull();
    expect(tryTrivialFastPath("25", "en")).toBeNull();
  });

  it("long input → NOT trivial", () => {
    expect(
      tryTrivialFastPath(
        "Hello, I was wondering if you could help me with a question about the inventory report please",
        "en",
      ),
    ).toBeNull();
  });

  it("empty / whitespace → null", () => {
    expect(tryTrivialFastPath("", "en")).toBeNull();
    expect(tryTrivialFastPath("   ", "en")).toBeNull();
    expect(tryTrivialFastPath("\n\n", "en")).toBeNull();
  });

  it("product name that happens to contain a greeting substring → NOT trivial", () => {
    expect(tryTrivialFastPath("Diamond Sakura", "en")).toBeNull();
    expect(tryTrivialFastPath("Tell me about Diamond Sakura", "en")).toBeNull();
  });
});
