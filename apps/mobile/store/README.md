# store/ — listing texts and graphics

Single source of truth for both stores. Edit here, never in the consoles.

## Texts

| File | Consumer | Limits enforced there |
|---|---|---|
| `store.config.js` | `eas metadata:push` (App Store Connect) — wired via `eas.json` → `submit.production.ios.metadataPath` | title 30 · subtitle 30 · promo 170 · description 4000 · keywords 100 (comma-joined) · review notes 4000 |
| `play/<locale>/title.txt` | Play Console → Store listing (paste; or fastlane `supply` layout) | 30 |
| `play/<locale>/short_description.txt` | same | 80 |
| `play/<locale>/full_description.txt` | same | 4000 |
| `play/<locale>/changelogs-<versionCode>.txt` | Play Console → release notes | 500 |

Locales: `ar-SA` / `ar` is the **primary** listing (Apple reviews the primary locale), `en-US` secondary.
The `review` block in `store.config.js` carries the App Review contact and demo login. It is a JS
config precisely so that none of it lives in a tracked file: the values come from
`ASC_REVIEW_FIRST_NAME` / `ASC_REVIEW_LAST_NAME` / `ASC_REVIEW_PHONE` / `ASC_REVIEW_DEMO_USERNAME` /
`ASC_REVIEW_DEMO_PASSWORD` in the shell that runs `eas metadata:push` (runbook §7.4). Unset → the
`REPLACE_ME_*` placeholder is used and a warning is printed on stderr. Never paste the real values
into this file. (`eas metadata:pull` only writes JSON, so it cannot target this file — App Store
Connect is downstream of it, not a source.)

Human-answered forms (age rating, privacy nutrition label, Play Data safety) and the screenshot shot
list live in `mobile-dev-docs/11-store-listing.md` (§6).

## Graphics

Every file below was checked with `sips -g pixelWidth -g pixelHeight -g hasAlpha`. All are opaque PNG.

| Asset | Files | Size | Where it goes |
|---|---|---|---|
| iOS 6.9" screenshots | `screenshots/ar/01…08-*.png` (8), `screenshots/en/01…08-*.png` (8) | 1320×2868 | App Store Connect → app → version → **Previews and Screenshots → iPhone 6.9" Display**; switch the localization picker (top-right) between Arabic (primary) and English. Apple reuses the 6.9" set for smaller iPhones. No iPad set (`supportsTablet: false`). **Note:** these PNGs still carry an alpha channel (`hasAlpha: yes`); App Store Connect rejects transparent screenshots, so flatten before upload (`sips -s format jpeg` or a PIL `.convert("RGB")`). |
| iOS app icon | `assets/images/icon.png` (not in this folder) | 1024×1024 | Not uploaded by hand — EAS embeds it in the build from `app.config.ts → icon`; App Store Connect reads the 1024² icon from the binary. |
| Play hi-res icon | `play/icon-512.png` | 512×512 | Play Console → Grow → Store presence → **Main store listing → Graphics → App icon**. The S mark (`apps/web/public/logothestoro.png`) on white with exactly the padding of `assets/images/icon.png` (mark = 66.2 % of the side, centred). 32-bit PNG, 56 KB (limit 1 MB). |
| Play feature graphic | `play/feature-graphic-1024x500.png` | 1024×500 | Same page → **Feature graphic**. White ground, the Arabic wordmark (`assets/images/logo-ar.png`) on the left, a phone-framed crop of `screenshots/ar/01-dashboard.png` on the right; no typeset text, so one file serves every Play locale. 52 KB (limit 15 MB). |
| Play phone screenshots | `play/screenshots/ar/01…08-*.png` (8), `play/screenshots/en/01…08-*.png` (8) | 1080×2400 | Same page → **Phone screenshots** for the default (Arabic) listing; for English open **Store listing → Manage translations → English (United States) → Graphics** and tick "use different graphics for this language". Play shows the first four in the listing header — keep 01–04 first. Each ≤ 352 KB (limit 8 MB), all inside Play's 16:9…9:16 / 320–3840 px envelope. |
| Play 7-inch / 10-inch tablet screenshots | — (skipped) | 1080×1920 or similar | **Not produced.** The tablet slots are optional in Play Console and `supportsTablet` is off for the app; leave them empty. If a reviewer ever asks, resize the phone set with the same script — the console accepts any 16:9…9:16 image there too. |

The Play screenshots are made from the iOS 6.9" captures: fit to **2400 px tall** (→ 1105 px wide)
then centre-crop 12 px off each side to 1080. (Scaling to 1080 wide first gives only 2347 px of
height — short of 2400 — so the crop runs along the width, not the height.) Both locales get the
identical crop so the stores can A/B them. The captures are iPhone frames (Dynamic Island, iOS status
bar); Play accepts them, but replace them with Pixel 9 Pro captures (`11-store-listing.md` §6 device
setup) once an Android build exists.

Regenerate everything with `python3 apps/mobile/store/play/make-assets.py` (Pillow only — icon
padding is measured from `icon.png`, the feature graphic is composed with
`ImageDraw.rounded_rectangle` plus a Gaussian-blurred shadow, screenshots are LANCZOS-resized).
