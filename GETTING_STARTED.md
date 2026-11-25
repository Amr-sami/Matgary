# Getting Started — Matgary / Storo

Runbook for bringing a fresh machine (or a fresh AI agent) to the same
working state as the main dev environment. Covers the web backend, the
Expo mobile app, Postgres + Redis, AI Agent env wiring, and iOS
simulator/device install.

> Prefer the script if there's one — the manual steps below mirror what
> `npm run db:up`, `npm run db:migrate`, `npm run db:seed:demo`, and
> `npx expo run:ios` do.

---

## 1 · Prerequisites

Install these once per machine:

| Tool | Why | How |
|---|---|---|
| **Node 22+** | Monorepo runtime (see `engines.node`) | `brew install node@22` or [nvm](https://github.com/nvm-sh/nvm) |
| **npm** | Workspace manager (bundled with Node) | — |
| **Docker Desktop** | Postgres 16 + Redis 7 locally | [docker.com](https://docker.com) |
| **Xcode 15+** (macOS only) | iOS simulator + device builds | Mac App Store |
| **Xcode CLI tools** | `xcrun`, `pod`, `xcodebuild` | `xcode-select --install` |
| **CocoaPods** | iOS native deps | `sudo gem install cocoapods` |
| **Watchman** (optional, speeds Metro) | File watcher | `brew install watchman` |
| **gh** (optional) | Branch/PR management | `brew install gh` |

Android build is optional — this guide covers iOS only. For Android,
install Android Studio + JDK 17 + an emulator before running
`npx expo run:android`.

---

## 2 · Clone + install

```bash
git clone https://github.com/Amr-sami/Matgary.git
cd Matgary

# Monorepo install — do ONE install at the root, not inside each workspace.
# npm workspaces will hoist everything correctly.
npm install

# Native iOS deps (CocoaPods). Only needed before the first mobile build.
cd apps/mobile/ios && pod install && cd -
```

---

## 3 · Environment variables

### 3.1 · Web (`apps/web/.env`)

```bash
cp apps/web/.env.example apps/web/.env
```

Then fill the **required** values in `apps/web/.env`:

```bash
# Database — matches docker-compose defaults. Leave as-is for local dev.
DATABASE_URL=postgres://matgary:matgary@localhost:5434/matgary
APP_DATABASE_URL=postgres://matgary_app:matgary_app@localhost:5434/matgary
ADMIN_DATABASE_URL=postgres://matgary_admin:matgary_admin@localhost:5434/matgary

# Auth.js — generate with: openssl rand -base64 32
AUTH_SECRET=<paste-32-bytes>

# Encryption key for WhatsApp tokens & collections raw messages
# Generate with: openssl rand -base64 32
SECRET_KEY=<paste-32-bytes>

# Platform admin session — openssl rand -base64 32
ADMIN_SESSION_SECRET=<paste-32-bytes>

# Redis — optional in dev; ok to leave as-is (compose maps to 6381)
REDIS_URL=redis://localhost:6381

# AI Agent (Gemini). Create a free key at https://aistudio.google.com/apikey
GEMINI_API_KEY=<your-gemini-key>
GEMINI_MODEL=gemini-3.6-flash

# Optional Groq fallback — leave empty if you don't have one
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b

# Cron bearer (any long random string; set only if you'll run cron routes)
CRON_SECRET=<openssl rand -base64 48>
```

Everything else in `.env.example` (Meta WhatsApp, SMTP, Sentry, Paymob)
can stay empty — those features degrade gracefully when unconfigured.

> **Critical:** `AUTH_SECRET` is the HMAC key for AI pending-action
> tokens. If you rotate it, every outstanding confirmation invalidates.

### 3.2 · Mobile (`apps/mobile/.env`)

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Fill in your Mac's LAN IP so a physical iPhone can reach the web
backend (the simulator can use `localhost`, a phone cannot):

```bash
# Find your Mac's IP:
#   ipconfig getifaddr en0          (Wi-Fi)
#   ipconfig getifaddr en1          (Ethernet, if applicable)

EXPO_PUBLIC_API_URL=http://<YOUR_MAC_LAN_IP>:3003
EXPO_PUBLIC_API_PORT=3003

# Dev-only autologin so the simulator doesn't need typing every build
EXPO_PUBLIC_DEV_IDENTIFIER=test@matgary.local
EXPO_PUBLIC_DEV_PASSWORD=Test1234!
EXPO_PUBLIC_DEV_AUTOLOGIN=1
```

> **Gotcha:** EXPO_PUBLIC_* vars are inlined at **bundle time**. If you
> change the IP, you must restart Metro AND reload the dev client on
> the device. See §7 below.

---

## 4 · Start Postgres + Redis

```bash
npm run db:up      # docker compose up -d postgres redis
docker compose ps  # both containers should show "healthy"
```

Shut down later with `npm run db:down`.

The first `db:up` runs `infra/init-postgres.sql`, which creates the
`matgary_app` (RLS-enforced) and `matgary_admin` (BYPASSRLS) roles.

---

## 5 · Database — migrate + seed

```bash
# Apply every migration in apps/web/lib/db/migrations/
npm run db:migrate

# Seed one test shop (test@matgary.local / Test1234!)
npm run db:seed

# OR seed a realistic demo shop with ~6 months of sales for the AI
# Agent to have data to talk about:
npm run db:seed:demo
```

| Script | Users it creates | Content |
|---|---|---|
| `db:seed` | 1 test owner | Empty shop |
| `db:seed:three` | 3 shops | Isolation smoke-test fixtures |
| `db:seed:rich` | 1 shop | Rich catalog + many sales |
| `db:seed:demo` | 1 "Explore the demo" shop | 6 months of realistic sales — use this for AI Agent demos |

---

## 6 · Start the web dev server

In **one terminal**, bound on `0.0.0.0` so the phone can reach it:

```bash
cd apps/web
npm run dev:lan      # next dev -H 0.0.0.0 -p 3003
```

- Web UI: http://localhost:3003 (on this Mac)
- Phone API: http://&lt;YOUR_MAC_LAN_IP&gt;:3003 (same network)

Log in with whatever the seed created (`test@matgary.local` /
`Test1234!` for `db:seed`).

> Quick API sanity check from your Mac:
> ```bash
> curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
>   -X POST http://<YOUR_MAC_LAN_IP>:3003/api/v1/auth/login \
>   -H "Content-Type: application/json" \
>   -d '{"identifier":"test@matgary.local","password":"Test1234!"}'
> ```
> Expect `200 application/json`. Anything else → see §9.

---

## 7 · Start the Expo mobile app

In a **second terminal**:

```bash
cd apps/mobile
npx expo start --dev-client --lan
```

Metro will boot on `http://localhost:8081` and advertise over your LAN.

### 7.1 · iOS simulator

```bash
# in a third terminal (keeps Metro running)
cd apps/mobile
npx expo run:ios --no-install   # --no-install skips re-running pod install
```

First build takes 5–10 min (React Native pods compile under Hermes).
Later builds reuse the DerivedData cache and finish in ~1 min. The
simulator opens automatically with Metro's URL.

### 7.2 · Physical iPhone (USB or paired Wi-Fi)

```bash
# Confirm the device shows up as "connected"
xcrun devicectl list devices

# Build + sign + install. Replace "iPhone (2)" with your device's name.
cd apps/mobile
npx expo run:ios --device "iPhone (2)" --no-install
```

**Free Apple ID caveat.** A free Apple Developer account cannot sign
entitlements for Associated Domains or Push Notifications. If signing
fails with "requires a provisioning profile with …", hand-strip the
file to an empty dict and retry:

```bash
# apps/mobile/ios/stwrw/stwrw.entitlements
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
```

Note: `expo prebuild --clean` will regenerate this file. Re-strip
after every clean prebuild until you have a paid Apple Developer
account.

### 7.3 · After the app installs

The dev client fetches its JS bundle from Metro on every launch. If
you don't see your UI, check Metro's log — a `BUNDLE` line means the
phone connected successfully.

Troubleshooting:
- **Blank splash + "Expected MIME type application/javascript, got text/html"** —
  the phone is pointing at a wrong port. Shake the phone → "Settings" →
  "Configure bundler" → set `http://<YOUR_MAC_LAN_IP>:8081`.
- **"Expected application/json, got text/html"** — the app is talking to
  the right Metro but hitting a wrong API URL for /api/v1/auth/login.
  Your `apps/mobile/.env` IP is stale; fix it, **restart Metro**, then
  shake → Reload on the device.

---

## 8 · Running tests

```bash
# Full web suite (Vitest, ~1900 tests, needs the Postgres from §4)
cd apps/web
npm test

# One file
npx vitest run tests/repo/ai-supplier-account-payment.test.ts

# Live Gemini acceptance (costs real tokens — gated behind an env var)
PHASE_B_LIVE=1 npx vitest run tests/repo/ai-wave2-acceptance.test.ts

# E2E (Playwright, needs the dev server running on 3003)
npm run test:e2e

# Mobile unit tests
cd apps/mobile && npm test
```

Expected baseline:
- `apps/web` suite: ~1800 passing, ~18 failing (pre-existing
  collections/cron/sale-alerts — unrelated to the AI Agent).
- `apps/mobile` suite: passing, with mobile Vitest config.

---

## 9 · Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `AUTH_SECRET is not set; AI write confirmation is disabled.` | `.env` missing key | Generate + paste one |
| `AI_DISABLED` in `/api/ai/chat` responses | `GEMINI_API_KEY` empty | Add it in `apps/web/.env` |
| `pg_isready` failing | Docker not running | `docker compose up -d postgres` |
| Metro's log shows no BUNDLE after device launch | Dev client points at wrong bundler URL | Shake phone → change server to `http://<MAC_IP>:8081` |
| Login returns 401 on correct password | Database empty — never ran `db:seed` | `npm run db:seed` |
| "Pod install hung" during `expo run:ios` | Stale Pods cache | `cd apps/mobile/ios && rm -rf Pods Podfile.lock && pod install` |
| "iPhone may need to be unlocked" | Phone screen lock during install | Unlock + set Auto-Lock → Never for the build window |
| Build-time: free-Apple-ID entitlements error | aps-environment / associated-domains in entitlements | Hand-strip `ios/stwrw/stwrw.entitlements` (see §7.2) |

---

## 10 · Contributing — the git workflow

```bash
# Base branch: feat/monorepo-mobile (active) → will land on main
git checkout feat/monorepo-mobile
git pull origin feat/monorepo-mobile

# Work on a focused branch
git checkout -b feat/<your-slice>

# Stage ONLY your files — never `git add .` on this branch (there's a
# lot of in-flight cross-feature work).
git add apps/web/path/to/your/file.ts
git commit -m "feat(scope): short imperative summary"

git push -u origin feat/<your-slice>
gh pr create --base feat/monorepo-mobile --fill   # or via the web UI
```

### Commit message style

Conventional commits, one-line summary ≤ 72 chars, scope in parens:

```
feat(ai): Storo AI Agent — purchases, analytics, reasoning, voice
fix(collections): late-arrival link only when no pending sale fits
test(mobile): wizard flow settles and retries the hub entry
chore(monorepo): packages + root tooling + pricing docs
```

Include a `Co-Authored-By` trailer when an AI agent contributed:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## 11 · AI Agent quick reference

Once web + mobile are running and the owner is logged in:

- **Typed**: open AI Chat in the mobile app → type questions like
  "قيمة المخزون كام؟", "دفعت لحسين 10000", "متوسط الفاتورة الشهر ده كام؟".
- **Voice**: tap the mic icon → speak → release → the transcript
  appears in the composer → tap Send.
- **Attention summary**: "في حاجة محتاجة آخد بالي منها؟" → the Agent
  calls `get_shop_pulse` and surfaces 2–3 grounded signals.
- **Writes**: any staged mutation (purchase, payment, expense, payroll)
  produces a confirmation block with an HMAC-signed token. Execution
  only happens after the owner taps Confirm.

The full AI surface lives in `apps/web/lib/ai/` and is documented in
the commit history (see `cd5d6e1 feat(ai):` for the entrypoint).

---

## 12 · "I just want to prove it works" — 90-second smoke

```bash
npm install
npm run db:up
npm run db:migrate
npm run db:seed:demo
(cd apps/web && npm run dev:lan) &            # terminal 1
(cd apps/mobile && npx expo start --dev-client --lan) &   # terminal 2
# terminal 3 — pick one
npx expo run:ios                 # simulator
# OR
npx expo run:ios --device "iPhone (2)"   # physical phone
```

When the Storo app opens and you see the dashboard, you're set. Ask it
"قيمة المخزون كام؟" to prove the AI Agent is wired end-to-end.
