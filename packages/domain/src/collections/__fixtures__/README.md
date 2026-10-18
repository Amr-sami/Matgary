# Digital collections — message corpus (`samples.ts`)

The fixtures behind every parser template of spec 06 (§4.14). Read this before adding or changing one.

## 1. The rule: never invent a message format

Only two kinds of sample may back a template (`CollectionTemplate.sampleIds`):

- **`published`** — a bank / wallet message text published by a third party, with a source URL, copied
  **verbatim** from the research notes (`mobile-dev-docs/15-digital-collections/_research/wallets.md §5.1`,
  `instapay.md §4.3`). Never typed from memory.
- **`pilot`** — a real message from a pilot shop's phone, redacted through spec 15's export script
  (`apps/web/scripts/collections-export-shared-samples.ts`) or its capture protocol (spec 15 §4.9).

**`illustrative`** samples (the Zynk demo texts) are negatives only and never back a template. Synthetic
"InstaPay: …" samples are excluded because the research proved them invented (`[DABBARHA]` English samples,
`[MATRIX]`, `[SYLO]`, the `[MONYVI]` QA fixtures and the `[PAYEHAB]` placeholder; `instapay.md §4.4`,
`wallets.md §5.1`).

## 2. Masks and fills

The research notes mask third-party data (`0112xxxxx05`, `<NAME>`, `<SENDER NAME, Latin caps, cut: 25 chars>`);
the originals stay at the cited source and are never copied. `published` keeps the research masks (research
annotations such as `(12 digits)` are dropped). `fills` replace each mask with a **fixed synthetic value**, and
`text = applyFills(published, fills)`:

| Mask | Fill |
|---|---|
| phone and reference masks | every `x` → `7` (`٧` inside OC-2's Arabic-Indic reference) |
| `<NAME>` | `محمد احمد علي` |
| the 25-character Latin name (IP-NBE-1) | `AHMED MOHAMED ABDELRAHMAN` |
| the "38-character" Latin name (IP-NBE-2a) | `MOHAMED AHMED ABDELRAHMAN MAHMOUD SAYED` |
| the Arabic 6-word name (IP-NBE-2b) | `محمد احمد عبد الرحمن محمود علي` |
| the CIB 23-character name (IP-CIB-1) | `AHMED MOHAMED ABDELRAHM` |
| the BDC 30-character name (IP-BDC-1) | `MOHAMED AHMED ABDELRAHMAN SAID` |
| IP-NBE-3's receiver | `ABDELAZEEZ M****` |

The bank's **own** masks are kept as published (CIB `********0018`, IP-UNK-1 `xxx6201`).
`__tests__/fixtures.test.ts` fails on any `<…>` placeholder or `x{5,}` run left in a `text`.

## 3. Sources

| Tag | URL | File(s) | Read |
|---|---|---|---|
| `TAHWEEL-S` | https://github.com/ashrafeldawody/Tahweel | `packages/server/src/parsers/{vodafone-cash,etisalat-money,orange-cash}.samples.json` (commit `b140022`) | 2026-09-27 |
| `DABBARHA` | https://github.com/ziadismael/dabbarha | `src/services/sms/samples.ts` (NBE samples only; its English bank / InstaPay samples are synthetic) | 2026-09-27 |
| `SPENDWISE` | https://github.com/yshams-03/spendwise | `lib/data/sample_messages.dart` | 2026-09-27 |
| `MATTIYA` | https://github.com/Muhammadattiya/Expenses-Tracking-PWA | `backend/test-sms-parser-full.js`, `backend/extracted_sms.json` | 2026-09-27 |
| `ZEN` | https://github.com/zenmoney/sms-formats/tree/master/src/CIB-eg_15670 | `formats/…_9062.txt` | 2026-09-27 |
| `ESLAM` | https://github.com/eslammohamedr/WalletTracker | `sms_export(2).txt` | 2026-09-27 |
| `FINFAST` | https://github.com/CyberDemon73/FinFast | `FinFast/Parsing/CIBParser.swift` | 2026-09-27 |
| `MONYVI` | https://github.com/Msamir22/Monyvi | spec 029, `qnb-egypt-patterns-03.ts` (corroboration only; its QA fixtures are not used) | 2026-09-27 |
| `ZYNK` | https://zynkapp.dev | demo buttons (illustrative negatives) | 2026-09-27 |

| Fixture | Source | Template |
|---|---|---|
| VF-1, VF-2, EM-1, EM-2, OC-1, OC-2, OC-3 | `TAHWEEL-S` | `vodafone_cash.*`, `etisalat_money.*`, `orange_cash.*` |
| IP-NBE-1, IP-NBE-3, IP-NBE-4 | `DABBARHA` | `nbe.sms.credit.v1`, `.debit.v1`, `.merchant_debit.v1` |
| IP-NBE-2a / IP-NBE-2b | `SPENDWISE` / `MATTIYA` | `nbe.sms.prepaid_credit.v1` |
| IP-CIB-1 / IP-CIB-1-D | `ZEN` / `FINFAST` | `cib.sms.credit.v1` / `.debit.v1` |
| IP-QNB-1, IP-QNB-1-D / IP-QNB-PAIR-D | `ESLAM` / `MATTIYA` | `qnb.sms.credit.v1` / `.debit.v1` |
| IP-BDC-1, IP-UNK-1, IP-ADIB-1 | `MATTIYA` | `bdc.sms.credit.v1`, `generic_ipn.sms.credit.v1`, `adib.sms.debit.v1` |
| ZYNK-OTP, ZYNK-CARD, ZYNK-PAY, ZYNK-ATM | `ZYNK` | none (negatives) |

## 4. The Tahweel MIT notice

The wallet sample texts (VF-1, VF-2, EM-1, EM-2, OC-1, OC-2, OC-3) come from Tahweel's
`packages/server/src/parsers/*.samples.json` (MIT, commit `b140022`, `wallets.md §5.1`). Only sample **texts**
(data) are copied, no code, so the app's about-screen licence list needs no entry (03 §D.8). The licence below
is copied verbatim from the repository's `LICENSE` file (fetched 2026-10-18 from
https://raw.githubusercontent.com/ashrafeldawody/Tahweel/main/LICENSE, blob `ba3d10355e1dff866cf981fc19e086bcd27b6426`;
GitHub reports it as MIT):

```
MIT License

Copyright (c) 2026 Ashraf Eldawody

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 5. The other repositories' licences

UNVERIFIED. Each of those fixtures stores only a bank's short notification template, with personal data
replaced by the synthetic fills above, and no code. How to verify: open each repository of §3 and record the
licence GitHub shows (some have none, which means all rights reserved; a short factual message template is
still the bank's wording, not the repository author's).

## 6. Adding a pilot sample (promotion, spec 06 §4.15)

A promotion `published_sample` → `pilot_verified` is a reviewed code change:

1. Export the owner-shared messages with spec 15's script (redaction is allowlist-based; the developer never
   sees raw text):
   `cd apps/web && npx tsx --tsconfig tsconfig.scripts.json scripts/collections-export-shared-samples.ts --tenant <uuid> > shared-<date>.redacted.json`
   (or `--input <capture>.jsonl` for the spec 15 §4.9 capture format).
2. Add **≥ 3** `kind: "pilot"` fixtures from **≥ 2** distinct `pilot.phoneId` (`PROMOTION_RULE`), each from a
   `fixtureDraft`: id `PILOT-<provider>-<n>`, `published` = the redacted body, `fills` as exported, `expect`
   checked by a human against the phone's bank / wallet app (drop `needsHumanCheck`).
3. Set the template's `senderIds` (SMS) / `packages` (notification) to values seen in `pilot.observedSender` /
   `observedPackage` (for `ios_notification`, the shortcut's `source` label).
4. Set `status: "pilot_verified"`, append the fixture ids to `sampleIds`; a promoted credit template must not
   be `autoConfirm: "never"`.
5. A second reviewer approves; the PR quotes the three redacted bodies and the phone models.

`__tests__/templates.test.ts` enforces 2–4. **Demotion:** a trusted-sender message for a promoted provider
landing as `unknown_format` / `fallback` means the operator changed its wording — set the status back to
`published_sample` in a hotfix, add the new sample as `.v<n+1>`, re-promote. Tenant-wide,
`features.collectionsAutoConfirm` is the immediate kill switch and needs no deploy.
