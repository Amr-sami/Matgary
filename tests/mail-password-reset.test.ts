import { describe, expect, it } from "vitest";
import { buildPasswordResetEmail } from "@/lib/mail/password-reset";

// Locale-aware reset email (#2, #3). The template builder is pure — these
// tests just lock down the contract so a future tweak can't silently send
// Arabic copy to an English-locale user.

const LINK = "https://example.com/en/reset-password?token=deadbeef";

describe("buildPasswordResetEmail", () => {
  it("English template carries an English subject + dir=ltr body", () => {
    const out = buildPasswordResetEmail("en", { link: LINK });
    expect(out.subject).toMatch(/reset your password/i);
    expect(out.subject).toContain("Matgary");
    expect(out.html).toContain('dir="ltr"');
    expect(out.text).toMatch(/password reset for your Matgary account/i);
    // Latin-only — Arabic glyphs should NOT appear in the EN template.
    expect(out.text).not.toMatch(/[؀-ۿ]/);
    expect(out.html).not.toMatch(/[؀-ۿ]/);
  });

  it("Arabic template carries an Arabic subject + dir=rtl body", () => {
    const out = buildPasswordResetEmail("ar", { link: LINK });
    expect(out.subject).toMatch(/إعادة ضبط كلمة المرور/);
    expect(out.subject).toContain("متجري");
    expect(out.html).toContain('dir="rtl"');
    expect(out.text).toMatch(/كلمة المرور/);
  });

  it("embeds the exact link in both templates (no rewriting)", () => {
    const ar = buildPasswordResetEmail("ar", { link: LINK });
    const en = buildPasswordResetEmail("en", { link: LINK });
    expect(ar.text).toContain(LINK);
    expect(ar.html).toContain(`href="${LINK}"`);
    expect(en.text).toContain(LINK);
    expect(en.html).toContain(`href="${LINK}"`);
  });

  it("honors a custom TTL in the body copy", () => {
    const ar = buildPasswordResetEmail("ar", { link: LINK, ttlMinutes: 15 });
    const en = buildPasswordResetEmail("en", { link: LINK, ttlMinutes: 15 });
    expect(ar.text).toContain("15");
    expect(en.text).toContain("15");
  });

  it("defaults TTL to 30 minutes when not specified", () => {
    const ar = buildPasswordResetEmail("ar", { link: LINK });
    const en = buildPasswordResetEmail("en", { link: LINK });
    expect(ar.text).toContain("30");
    expect(en.text).toContain("30");
  });
});
