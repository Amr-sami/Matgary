import { describe, expect, it } from "vitest";
import {
  normalizeEgyptPhone,
  normalizeEgyptPhoneAny,
  isValidEgyptPhone,
  isValidEgyptPhoneAny,
  normalizeEgyptLandline,
} from "@/lib/validators/egypt";

// Locks down onboarding shop-phone validation (#22). The normalizer was
// pre-existing; tests didn't exist for it. Adding them now so the
// onboarding action's gate has a safety net.

describe("normalizeEgyptPhone (mobile)", () => {
  it.each([
    ["01001234567", "+201001234567"],
    ["1001234567", "+201001234567"],
    ["+201001234567", "+201001234567"],
    ["00201001234567", "+201001234567"],
    ["+20 100 123 4567", "+201001234567"],
    ["+20-100-123-4567", "+201001234567"],
    ["(010) 0123 4567", "+201001234567"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeEgyptPhone(input)).toBe(expected);
  });

  it("normalizes Arabic-Indic digits", () => {
    expect(normalizeEgyptPhone("٠١٠٠١٢٣٤٥٦٧")).toBe("+201001234567");
  });

  it("normalizes Persian variant digits", () => {
    expect(normalizeEgyptPhone("۰۱۰۰۱۲۳۴۵۶۷")).toBe("+201001234567");
  });

  it("accepts all current mobile prefixes (010, 011, 012, 015)", () => {
    expect(normalizeEgyptPhone("01012345678")).toBe("+201012345678");
    expect(normalizeEgyptPhone("01112345678")).toBe("+201112345678");
    expect(normalizeEgyptPhone("01212345678")).toBe("+201212345678");
    expect(normalizeEgyptPhone("01512345678")).toBe("+201512345678");
  });

  it("rejects clearly-not-mobile input", () => {
    expect(normalizeEgyptPhone("")).toBeNull();
    expect(normalizeEgyptPhone(null)).toBeNull();
    expect(normalizeEgyptPhone(undefined)).toBeNull();
    expect(normalizeEgyptPhone("not-a-phone")).toBeNull();
    expect(normalizeEgyptPhone("123")).toBeNull();
    expect(normalizeEgyptPhone("01001")).toBeNull(); // too short
    expect(normalizeEgyptPhone("010012345678")).toBeNull(); // too long
    // 013 / 014 / 016 / 017 / 018 / 019 are not currently issued Egyptian
    // mobile prefixes; the validator deliberately rejects them.
    expect(normalizeEgyptPhone("01312345678")).toBeNull();
    expect(normalizeEgyptPhone("01612345678")).toBeNull();
  });

  it("isValidEgyptPhone mirrors normalize semantics", () => {
    expect(isValidEgyptPhone("01001234567")).toBe(true);
    expect(isValidEgyptPhone("xxx")).toBe(false);
    expect(isValidEgyptPhone(null)).toBe(false);
  });
});

describe("normalizeEgyptLandline", () => {
  it("normalizes Cairo (area code 2)", () => {
    expect(normalizeEgyptLandline("0227777777")).toBe("+20227777777");
    expect(normalizeEgyptLandline("+20 2 2777 7777")).toBe("+20227777777");
  });

  it("normalizes Alexandria (area code 3) and governorate codes", () => {
    expect(normalizeEgyptLandline("0331234567")).toBe("+20331234567");
    expect(normalizeEgyptLandline("0501234567")).toBe("+20501234567");
  });

  it("rejects mobile-shaped input (leading 1 is mobile territory)", () => {
    expect(normalizeEgyptLandline("01001234567")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(normalizeEgyptLandline("")).toBeNull();
    expect(normalizeEgyptLandline("hello")).toBeNull();
  });
});

describe("normalizeEgyptPhoneAny", () => {
  it("falls through to landline when mobile match fails", () => {
    expect(normalizeEgyptPhoneAny("01001234567")).toBe("+201001234567");
    expect(normalizeEgyptPhoneAny("0227777777")).toBe("+20227777777");
  });

  it("isValidEgyptPhoneAny is the boolean form", () => {
    expect(isValidEgyptPhoneAny("01001234567")).toBe(true);
    expect(isValidEgyptPhoneAny("0227777777")).toBe(true);
    expect(isValidEgyptPhoneAny("nope")).toBe(false);
    expect(isValidEgyptPhoneAny("")).toBe(false);
  });

  it("onboarding edge case: empty input is rejected (caller must handle optional)", () => {
    // Onboarding treats empty as "no phone, leave null". The normalizer
    // itself shouldn't silently turn empty into something valid.
    expect(normalizeEgyptPhoneAny("")).toBeNull();
  });
});
