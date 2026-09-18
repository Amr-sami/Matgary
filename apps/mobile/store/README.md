# store/ — listing texts

Single source of truth for both stores. Edit here, never in the consoles.

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
list live in `mobile-dev-docs/11-store-listing.md`.
