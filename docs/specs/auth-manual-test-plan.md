# Auth flow — manual test plan

Companion to `auth-flow-hardening.md`. Walk through these in a real
browser to verify every shipped fix actually works end-to-end. Each
section corresponds to one or more closed audit items.

**Setup**

1. Dev server running (`npm run dev`).
2. Two browsers or two private windows so you can hit AR and EN
   simultaneously, plus a third for clean cookie state.
3. A throwaway email you don't mind using for signup (or `samyamr819@gmail.com`
   for the "already taken" tests).
4. Reset Redis if you want a clean rate-limit slate:
   `docker compose exec redis redis-cli FLUSHDB`.

---

## 1. Open-redirect closed — #1

1. Open `http://localhost:3000/ar/login?next=https://example.com/danger`.
2. Sign in with valid credentials.
3. **Expected**: you land on `/` (the app root), NOT `example.com`.
4. Repeat with `?next=//example.com` and `?next=/\\evil` — same result.

## 2. Middleware preserves the query string — #26

1. While signed out, paste `http://localhost:3000/dashboard?from=yesterday`
   into the URL bar.
2. **Expected**: redirected to `/ar/login?next=%2Fdashboard%3Ffrom%3Dyesterday`.
3. Sign in.
4. **Expected**: you land on `/dashboard?from=yesterday` (query intact).

## 3. Locale switching — #i18n

1. Open `/ar/welcome`. Note `<html lang="ar" dir="rtl">` (DevTools → Elements).
2. Click the globe icon → "English".
3. **Expected**: full page reload (hard nav), URL becomes `/en/welcome`,
   `<html lang="en" dir="ltr">`, copy renders in English.
4. Switch back to العربية — same again in reverse.

## 4. Signup live email-check — #19

1. Go to `/ar/signup`.
2. Type a known-registered email (e.g. `samyamr819@gmail.com`).
3. **Expected**: under the field, "هذا البريد مسجّل بالفعل — استخدم
   تسجيل الدخول" appears, "التالي" button disables.
4. Change to a fresh email like `freshtest+${Date.now()}@example.com`.
5. **Expected**: "متاح ✓" appears, Next becomes enabled.
6. Repeat on `/en/signup` — copy should be English.

## 5. Signup live email-check rate-limit — #8

1. Repeat step 4 above 70+ times within a minute (script in the JS console:
   `for (let i = 0; i < 70; i++) await fetch('/api/account/email/check?email=x'+i+'@y.com')`).
2. **Expected**: after hitting 60 requests within 60 seconds, all
   subsequent responses return `{available:false, reason:"invalid"}` — same
   shape as a malformed email, so an enumeration attacker can't tell.
3. Wait 60s, repeat with a real email — should resume working.

## 6. Signup error states are localized — #4, #19

1. Open `/en/signup`. Type any malformed email like `x`.
2. **Expected**: the inline status hint says "Available" or doesn't appear
   for malformed; Next stays disabled.
3. Force a 429 by hammering signup quickly (rate-limit is 5/hour/IP). After
   the 6th attempt:
4. **Expected**: error message reads "Too many attempts. Please try again
   in a bit." (English), NOT Arabic.

## 7. Signup → onboarding pre-fill — #11

1. Sign up with store name "Coffee Lab".
2. After redirect to `/ar/onboarding`, look at step 1.
3. **Expected**: the shop-name input is pre-filled with "Coffee Lab".

## 8. Onboarding phone validation — #22

1. On `/ar/onboarding` step 1, enter `01001234567` in the phone field.
2. **Expected**: no error, Next button enabled.
3. Try `123` or `not-a-phone`.
4. **Expected**: red error under field "أدخل رقماً مصرياً صحيحاً
   (مثل 01001234567)", Next button disabled.
5. Try Arabic-Indic digits: `٠١٠٠١٢٣٤٥٦٧`.
6. **Expected**: accepted (validator normalizes to `+201001234567`).
7. Clear the phone field entirely (it's optional).
8. **Expected**: Next button re-enables.

## 9. Onboarding wizard step labels — #24

1. On `/ar/onboarding`, watch the small caption under the progress dots.
2. **Expected**: shows "خطوة 1 من 3 · معلومات المتجر" at step 1,
   "خطوة 2 من 3 · اختيار البداية" at step 2,
   "خطوة 3 من 3 · مراجعة" at step 3 — so step 3 doesn't look like more
   form-filling.

## 10. Onboarding step-3 tips per preset + real Links — #12, #13, #23

1. At step 2, pick "تجربة Corner Store الكاملة" (cornerstore).
2. Advance to step 3.
3. **Expected**: 3 tips, the colored words are real links —
   - "إضافة منتج" → `/inventory/new`
   - "المبيعات" → `/sales`
   - "الإعدادات" → `/settings`
   - hover them: cursor → pointer, underline appears.
4. Hit Back, change to "ابدأ من الصفر" (blank).
5. Advance to step 3.
6. **Expected**: 3 DIFFERENT tips — first one is "عرّف الأقسام والخصائص
   من الإعدادات" (the "Add products" tip from cornerstore is now second).

## 11. Onboarding completion no longer races — #6, the JWT-refresh fix

1. Complete the wizard. Click "ابدأ" once.
2. **Expected**: you land on `/` (the app dashboard) on the FIRST click.
   You should NOT bounce back to step 1.

## 12. Onboarding gate — middleware

1. Sign up with a fresh email but DON'T click "ابدأ" — leave the wizard.
2. Manually type `http://localhost:3000/` in the URL bar.
3. **Expected**: bounced to `/ar/onboarding` (or `/en/onboarding`).
4. Try `/dashboard`, `/sales`, `/insights` — all redirect to onboarding.
5. `/api/categories` while authenticated but un-onboarded → 403
   `{error:"ONBOARDING_REQUIRED"}`.
6. The wizard itself (`/ar/onboarding`), `/api/auth/signout`, and
   `/api/account/password/*` should all stay reachable.

## 13. Login 2FA back-button cleanup — #15

1. Sign up a user, enable 2FA from `/account/security`, sign out.
2. Go to `/ar/login`, enter your email + password, submit.
3. The 2FA prompt appears. Click "رجوع" (Back).
4. Edit the email field to a DIFFERENT registered email + password.
5. Submit again.
6. **Expected**: the precheck runs with the NEW email (not the cached
   previous one). Before the fix, the cached `emailValue` would survive
   and the wrong account's 2FA prompt could appear.

## 14. Login "no account?" hint — #17

1. Go to `/ar/login`.
2. Enter `definitely-not-real-${Date.now()}@nowhere.test` + any password.
3. Submit.
4. **Expected**: red generic error "البريد أو كلمة المرور غير صحيحة"
   AND a small grey hint "لا يوجد حساب بهذا البريد." with a
   "إنشاء حساب جديد" link to `/ar/signup`.
5. Retry with a real registered email + wrong password.
6. **Expected**: same generic red error, NO hint — the user already
   has an account; we don't reveal "password was wrong specifically".

## 15. Forgot-password echoes the email — #18

1. Go to `/ar/forgot-password`.
2. Submit `samyamr819@gmail.com`.
3. **Expected**: success state reads "إذا كان `samyamr819@gmail.com`
   مسجّلاً عندنا، …" — your email visible, LTR.

## 16. Reset email is locale-aware — #2, #3

1. Sign up a fresh user at `/en/signup`. This stores `users.locale = 'en'`.
2. From a clean window, go to `/en/forgot-password` and request a reset.
3. Check the inbox (or the dev mailer's log).
4. **Expected**: email subject "Reset your password — Matgary",
   body in English, link looks like
   `http://localhost:3000/en/reset-password?token=...`.
5. Repeat for an `/ar/signup` user → Arabic subject + body + `/ar/` link.

## 17. Reset link pre-validates — #9

1. Click an expired or fake reset link, e.g.
   `/ar/reset-password?token=garbage`.
2. **Expected**: "جاري التحقق من الرابط…" briefly, then the "Invalid or
   expired link" panel — no password form shown, no point in filling.
3. Click a fresh link from step 16 → password form appears immediately.

## 18. Reset success has a real button — #10

1. Complete a password reset.
2. **Expected**: success state shows a green check, the message,
   AND a "متابعة لتسجيل الدخول" button. Auto-redirect kicks in after
   ~5 seconds.
3. Click the button before the timer → immediate redirect.
4. Don't click → wait 5 s → still redirects.

## 19. Direction-driven form primitives — Phase 1.5

1. Open `/en/signup`. Click into the store-name input.
2. Type "Happy Store".
3. **Expected**: text flows left-to-right, label "Store name (shown to
   customers)" is left-aligned. NO RTL bleed.
4. Open `/ar/signup`, click into "اسم المتجر".
5. **Expected**: text flows right-to-left.

---

## Smoke command bundle

If you have curl handy:

```bash
# Open-redirect blocked (the /login HTML renders; whether it then redirects
# is verified by clicking through in a browser).
curl -s -o /dev/null -w "open-redirect login → %{http_code}\n" \
  "http://localhost:3000/ar/login?next=https://example.com"

# Locale redirect on bare slug.
curl -sI http://localhost:3000/welcome 2>&1 | grep -i "^location:"
curl -sI -H "Accept-Language: en-US" http://localhost:3000/welcome 2>&1 | grep -i "^location:"

# Email check (known-taken vs free vs malformed).
curl -s "http://localhost:3000/api/account/email/check?email=samyamr819@gmail.com"
curl -s "http://localhost:3000/api/account/email/check?email=brand-new-$(date +%s)@example.com"
curl -s "http://localhost:3000/api/account/email/check?email=not-an-email"

# Reset-token pre-validate.
curl -s "http://localhost:3000/api/account/password/reset/validate?token=garbage"
curl -s "http://localhost:3000/api/account/password/reset/validate?token=$(openssl rand -hex 32)"

# Onboarding gate on a logged-out request — should redirect to login.
curl -sI http://localhost:3000/ar/onboarding 2>&1 | grep -i "^location:"
```

Each line should print exactly what `auth-flow-hardening.md`'s
acceptance criteria say.
