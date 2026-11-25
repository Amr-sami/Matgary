# Storo — 90-second product reel

**Format:** 9:16 vertical, 1080 × 1920, ~90s
**Language:** Egyptian Arabic voice-over, Arabic on-screen captions
**Deliverables:** Reel, Facebook Reels, TikTok, WhatsApp Status
**Accuracy constraint:** Every scene shows a feature that ships today. Flagged swaps are noted inline.

---

## Shot list (seconds · visual · voice-over · caption · SFX)

### Scene 1 · The hook · 0:00 – 0:08

- **Visual.** Mid-shot, warm light, Egyptian store owner on a couch with a small coffee. Phone on the side table, screen dark. 2s beat. Phone lights up with a Storo push: **"تم تسجيل عملية بيع جديدة · 850 ج.م"**. He glances, smiles. No rush. Push the camera in on the phone.
- **Voice-over.** "تخيل تكون قاعد في بيتك… وتعرف إن في بيع حصل في محلك."
- **Caption.** `بيع جديد ✅`
- **SFX.** Cha-ching (the one at `apps/mobile/assets/sounds/cha_ching.wav` — that IS the real sale-alert sound). Establish it as the recurring motif.

### Scene 2 · The sale that triggered it · 0:08 – 0:17

- **Visual.** Match-cut from the owner's phone to the employee's phone at the till. Screen-capture the real mobile POS at `/sales`: add two items, enter cash, tap "تسجيل البيع". Receipt appears. Then **cut back** to the owner's living room: his phone shows the same sale under the notification bell (`NotificationBell` component).
- **Voice-over.** "أول ما البيع يتم، Storo بيوصّلك الخبر."
- **Caption.** `من المحل للموبايل في ثانية`
- **SFX.** POS click → cha-ching callback.

### Scene 3 · Daily owner digest · 0:17 – 0:27

- **Visual.** Transition: the notification icon expands into the **real daily digest** (`/api/digest/preview` renders this — screen-cap from a seeded demo). Numbers animate up: مبيعات اليوم, عدد الفواتير, الأكثر مبيعًا, المصاريف. Hold on the summary.
- **Voice-over.** "وفي آخر اليوم، تقرير مختصر يوصلك عشان تعرف محلك عمل إيه."
- **Caption.** `تقريرك اليومي`
- **SFX.** Soft counter transitions.
- **Accuracy note.** Use the digest's actual field set. Don't invent a "profit for the day" number in this card — the digest surfaces revenue + transactions + best-sellers; profit lives in Financials (Scene 9).

### Scene 4 · Mobile stock-take · 0:27 – 0:39

- **Visual.** The owner is now walking the aisles of his shop. Pulls out phone. Opens Storo → Inventory → starts a count (`/inventory-count/[id]`). Taps the scan icon → real scanner opens (`ScannerSheet`). Scans a product — the line updates. Scans another. Scans a third. A few jump-cuts; motion is quick.
- **Voice-over.** "عايز تعمل جرد؟ … مش لازم تقعد تعد وتكتب على الكمبيوتر. … امسك موبايلك. … سكان. … وخلصت."
- **Caption.** `جرد بالموبايل`
- **SFX.** Scan beep (the real one at `apps/mobile/assets/sounds/scan-beep.wav`) three times.

### Scene 5 · Employee attendance · 0:39 – 0:47

- **Visual.** Store door opens, employee walks in. Pulls out phone, opens Storo → Attendance → تسجيل دخول (`/attendance`). Geofence check happens silently. Cut to owner's phone: attendance roster (`AttendanceRoster`) shows the employee turned green / clocked-in with timestamp.
- **Voice-over.** "وموظفينك؟ … الحضور بيتسجل من الموبايل، وإنت شايف كل حاجة."
- **Caption.** `حضور من الموبايل`
- **SFX.** Subtle "whoosh" sync.

### Scene 6 · Receipt to the customer · 0:47 – 0:55

- **Visual.** POS finishes a sale. Owner (or cashier) taps the share icon on the receipt. iOS/Android share sheet opens → WhatsApp. Receipt PDF (`Invoice-2026-11-23-INV-XXXXX.pdf`) attaches. The customer's phone shows the WhatsApp chat with the PDF arriving.
- **Voice-over.** "والعميل كمان ياخد فاتورته على واتساب في ثواني."
- **Caption.** `فاتورة PDF أونلاين`
- **Accuracy note.** The receipt is a **PDF attachment**, not a public `/r/[id]` link. Do not show a browser page. Do not say "Storo sends it automatically" — the Owner taps share. Green API / WhatsApp Cloud API delivery is optional and must only be shown if the shop has it configured.

### Scene 7 · Customer ledger & wallet credit · 0:55 – 1:03

**(Replaces the "loyalty program" scene — Storo has a wallet/credit system, not tier-based loyalty.)**

- **Visual.** Customer search → open their profile (`apps/mobile/src/app/(app)/customers/[phone].tsx`). Show purchase history (3–4 rows), wallet credit balance, outstanding deferred balance. Owner taps "إضافة رصيد" → modal → +50 ج.م grant.
- **Voice-over.** "وكل عميل، عنده صفحته. عارف اشترى إيه، وله رصيد أو عليه فلوس."
- **Caption.** `عملاؤك في مكان واحد`
- **SFX.** Soft click.

### Scene 8 · Outstanding payments · 1:03 – 1:10

**(Honest reframing — Storo flags deferred balances for the Owner. Automated customer-side reminders are not in V1.)**

- **Visual.** Owner's dashboard or customer list highlights an "آجل · 450 ج.م" chip. Tap → `InvoiceSettleModal`. Customer settles. Chip disappears.
- **Voice-over.** "وعندك فاتورة لسه مفلوسة؟ … Storo بيبينها قدامك عشان تطالب بيها."
- **Caption.** `تذكير بالدفعات`
- **SFX.** Chime → paid-✓.

### Scene 9 · Real profit · 1:10 – 1:22

- **Visual.** Switch to a slightly more serious tone. Open the **Financials P&L** page (`/insights/financials` — real UI). Numbers cascade:
  - `+ المبيعات`
  - `− الخصومات`
  - `− المرتجعات`
  - `− تكلفة البضاعة (COGS)`
  - `− المصاريف التشغيلية`
  - `− الرواتب` *(from finalized payroll sheets — Payroll V1)*
  - `= صافي الربح`
- **Voice-over.** "وفي الآخر … أهم سؤال … أنا كسبت كام بجد؟ … Storo بيجمعلك أرقامك ويخليك شايف ربحك."
- **Caption.** `اعرف ربحك الحقيقي`
- **SFX.** Low rising synth; final number lands with a soft "ding".
- **Accuracy note.** Don't claim "exact profit to the pound". The P&L is accurate for what's recorded in Storo; costs the Owner never entered aren't in there. Phrasing: "ربحك الحقيقي من اللي مسجّل" — honest, not overclaimed.

### Scene 10 · AI · 1:22 – 1:27

- **Visual.** Open the Storo AI chat (`/ai-chat`). Owner types: **"إيه أكتر منتج مبيعًا الشهر ده؟"** Agent replies with a real `render_product_card` + short text. 2s hold.
- **Voice-over.** "ولو عايز تسأل … عندك AI فاهم شغلك."
- **Caption.** `AI يفهم شغلك`
- **SFX.** Soft message-in.
- **Accuracy note.** Use a question the Agent actually handles well. Good options: "مبيعاتي النهارده", "أكتر منتج مبيعًا", "إيه المخزون القليل؟", "كشف راتب أحمد لشهر ١١" (works now with V1). Avoid open-ended business-advice questions.

### Scene 11 · Montage + CTA · 1:27 – 1:30

- **Visual.** Fast 1-frame-per cuts (≈6 beats): sale push → POS → digest → scan → attendance → receipt → P&L. Everything collapses inward into the Storo logo on white.
- **Voice-over.** "كل ده … في مكان واحد. … Storo. … إدارة محلك حتى وإنت مش فيه."
- **Caption.** Bold title:

```
Storo
إدارة محلك… حتى وإنت مش فيه

جرّبه دلوقتي
```

- **SFX.** Final cha-ching callback → silence.
- **Accuracy note.** Drop "أول شهر مجانًا" **unless** Marketing has confirmed the promo is live. Paymob billing is deferred; a free-trial claim without a billing page behind it is a trust risk. If you want that CTA, confirm with Product and I'll add the trial activation path separately.

---

## What the editor needs from the codebase

Capture these real screens at 1080×1920 (zoom in / crop vertically where needed) — paths all exist:

| Screen | Path | Capture via |
|---|---|---|
| Sale push notification | — | Trigger a sale from a staff device; capture owner device lock-screen. |
| Mobile POS | `apps/mobile/src/app/(app)/sales.tsx` | iOS simulator recording. |
| Notification bell list | `apps/mobile/src/components/shell/NotificationBell.tsx` | Same. |
| Daily digest email | `/api/digest/preview?send=false` | Render to PNG at 1080w. |
| Inventory count | `apps/mobile/src/app/(app)/inventory-count/[id]/` | Simulator + scan loop. |
| Scanner | `apps/mobile/src/components/scanner/ScannerSheet.tsx` | Use real barcodes. |
| Attendance (self) | `/attendance` | Simulator. |
| Attendance roster (owner view) | `apps/web/components/team/AttendanceRoster.tsx` | Web screen-cap. |
| Receipt share | `apps/mobile/src/components/receipt/ReceiptActions.tsx` | Simulator — real OS share sheet. |
| Customer profile | `apps/mobile/src/app/(app)/customers/[phone].tsx` | Simulator. |
| Deferred invoice settle | `components/customers/InvoiceSettleModal.tsx` | Web. |
| Financials / P&L | `/insights/financials` | Web — animate line-by-line in After Effects. |
| AI chat | `apps/mobile/src/app/(app)/ai-chat.tsx` | Simulator — use a prepped message. |

**Seed demo data first** so numbers are flattering and consistent across cuts:

```
cd apps/web
npm run db:seed:rich     # realistic product/sale history
npm run db:seed:demo     # the clone template (already done on your laptop)
```

Then set the sim's locale to `ar`, stage a tenant, and record. Keep the shop name, customer names, and employee names consistent across every clip.

---

## Audio assets you already own

- `apps/mobile/assets/sounds/cha_ching.wav` — sale alert motif
- `apps/mobile/assets/sounds/scan-beep.wav` — scan beep
- `apps/mobile/assets/sounds/generic_notification.wav` / `.caf` — fallback notification

Background music: pick a licensed modern Arabic-SaaS track (ElevenLabs or Epidemic Sound both work). Start calm; subtle rise through scene 4; shift to a sophisticated pad for scene 9; small build for scene 10; peak on the CTA.

---

## Voice-over

Script is written above in short Egyptian lines. Options for recording:

1. **ElevenLabs Arabic voice** (e.g. "Mohamed" / a male Egyptian-dialect voice). Export at 48 kHz WAV. Costs ~$0 on a free tier for 90s.
2. **Record a voice actor** on Fiverr / Voice123 — search "Egyptian Arabic male voiceover". Give them this script with the pauses marked by `…`.

Target delivery: natural, warm, mid-tempo. Not news-anchor energy. Not influencer energy. Like a friend explaining Storo over tea.

---

## Captions (Arabic, on-screen)

Short per scene, in Cairo font (same as the app — brand consistency). Appear bottom-center, fade in/out with the scene. Full list in order:

```
بيع جديد ✅
من المحل للموبايل في ثانية
تقريرك اليومي
جرد بالموبايل
حضور من الموبايل
فاتورة PDF أونلاين
عملاؤك في مكان واحد
تذكير بالدفعات
اعرف ربحك الحقيقي
AI يفهم شغلك
Storo — إدارة محلك حتى وإنت مش فيه
جرّبه دلوقتي
```

---

## What I'm NOT doing in this document (and why)

- **No fake UI mock-ups.** Every frame is captureable from the running app.
- **No "WhatsApp API delivery" claim.** Storo shares the receipt through the OS sheet; implying autosend misrepresents the product.
- **No loyalty points.** Swapped for customer ledger + wallet credit — real, same emotional beat.
- **No automated customer-side payment reminder.** Reframed as Owner-visible outstanding balance.
- **No "exact profit" claim.** Honest copy: "ربحك الحقيقي من اللي مسجّل".
- **No free-trial CTA** unless billing is wired. I removed the أول شهر مجانًا line; Marketing can re-add it when Paymob is live.

---

## Handoff — what to actually do with this

Give this file to an editor (Adobe Premiere / CapCut / Final Cut) alongside the captured screens and the two sound effects. Any mid-tier motion designer can turn it into the finished 90s reel in 1–2 days. If you want, I can also:

- Script the exact ElevenLabs API call to generate the voice-over as a wav.
- Write the AfterEffects expression / Lottie JSON for the P&L cascade animation.
- Produce an English version of this script for international channels.

Just say which.
