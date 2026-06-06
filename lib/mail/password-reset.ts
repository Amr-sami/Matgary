/**
 * Localized password-reset email templates. Kept here (not in
 * dictionaries/*.json) because they contain HTML and are only ever read
 * server-side — no need to bundle them into client JS.
 *
 * Templates take a fully-built reset URL (with locale prefix already
 * applied by the caller) and return { subject, text, html }.
 */

import type { Locale } from "@/lib/i18n/config";

interface Built {
  subject: string;
  text: string;
  html: string;
}

interface TemplateInput {
  /** Fully-built link including locale + token — caller's responsibility. */
  link: string;
  /** 30 by default; surfaced in the body so the user knows the deadline. */
  ttlMinutes?: number;
}

function arabicTemplate({ link, ttlMinutes = 30 }: TemplateInput): Built {
  return {
    subject: "إعادة ضبط كلمة المرور — متجري",
    text:
      `لقد طُلب إعادة ضبط كلمة المرور لحسابك على متجري.\n\n` +
      `افتح هذا الرابط خلال ${ttlMinutes} دقيقة لاختيار كلمة مرور جديدة:\n${link}\n\n` +
      `إذا لم تكن أنت، يمكنك تجاهل هذه الرسالة. كلمة المرور الحالية ستبقى كما هي.`,
    html:
      `<div dir="rtl" style="font-family:system-ui,-apple-system,Segoe UI,Tajawal,Cairo,sans-serif;font-size:15px;line-height:1.7;color:#222">` +
      `<p>لقد طُلب إعادة ضبط كلمة المرور لحسابك على متجري.</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1203E3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">اختر كلمة مرور جديدة</a></p>` +
      `<p style="font-size:13px;color:#666">الرابط صالح لمدة ${ttlMinutes} دقيقة. إذا لم تكن أنت، يمكنك تجاهل هذه الرسالة.</p>` +
      `</div>`,
  };
}

function englishTemplate({ link, ttlMinutes = 30 }: TemplateInput): Built {
  return {
    subject: "Reset your password — Matgary",
    text:
      `Someone requested a password reset for your Matgary account.\n\n` +
      `Open this link within ${ttlMinutes} minutes to choose a new password:\n${link}\n\n` +
      `If this wasn't you, you can ignore this email. Your current password will stay the same.`,
    html:
      `<div dir="ltr" style="font-family:system-ui,-apple-system,Segoe UI,Inter,Arial,sans-serif;font-size:15px;line-height:1.7;color:#222">` +
      `<p>Someone requested a password reset for your Matgary account.</p>` +
      `<p><a href="${link}" style="display:inline-block;background:#1203E3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>` +
      `<p style="font-size:13px;color:#666">The link is valid for ${ttlMinutes} minutes. If this wasn't you, you can ignore this email.</p>` +
      `</div>`,
  };
}

export function buildPasswordResetEmail(locale: Locale, input: TemplateInput): Built {
  return locale === "en" ? englishTemplate(input) : arabicTemplate(input);
}
