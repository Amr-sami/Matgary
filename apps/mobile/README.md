# @matgary/mobile

React Native (Expo SDK 57, RN 0.86 new arch, expo-router) client for **Matgary / TheStoro**, served by
the same backend as `apps/web`. iOS dev client only on this Mac; Android is built by EAS.

## Run

```bash
cd apps/web && npx next dev -p 3003         # backend; .env sets EXPO_PUBLIC_API_PORT=3003 (3001 is taken)
cd apps/mobile && npm run ios:sim           # ad-hoc-signed xcodebuild + simctl install (SIM_UDID overrides the device)
npx expo start                              # Metro; then open the dev client:
xcrun simctl openurl booted "exp+matgary://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"
```

`npm run ios:prebuild` after adding a config plugin or usage string (`ios/` is gitignored). `expo-modules-jsi`
builds under Xcode 26.3 only via `patches/` (root `postinstall`). Expo Go cannot run this app. A physical
device needs `EXPO_PUBLIC_API_URL=http://<mac-lan-ip>:3003` in `.env`.

## Build

`eas.json`: `development` / `preview` / `production` (+ `submit`). Everything past a simulator build needs an
account — `mobile-dev-docs/12-release-runbook.md` has the commands per step, `HANDOFF.md` §9 the checklist.
`npx expo-doctor` → 20/21 (the Metro warning is deliberate).

## Test

```bash
npm run e2e                                                     # Maestro flows in e2e/ against the booted simulator
node --test --experimental-strip-types src/**/__tests__/*.test.ts   # zsh glob; 7 files, 63 tests
npx tsc --noEmit -p .                                           # must print nothing
```

## Dev knobs (`.env`, `__DEV__`-gated, baked at bundle time — `expo start --clear` after changing)

`EXPO_PUBLIC_DEV_AUTOLOGIN=1` + `EXPO_PUBLIC_DEV_IDENTIFIER/PASSWORD` skip the login form ·
`EXPO_PUBLIC_DEV_LOCALE=ar|en` forces a locale · `/sync` has a "Simulate offline" switch ·
`xcrun simctl openurl <udid> "matgary://<route>"` reaches any signed-in screen.

## Where things live

```
src/app/        expo-router tree: (public) signed out · (app) signed in · legal/ · +native-intent.ts (universal links)
src/api/        binds @matgary/api-client to this device (bearer, X-Branch-Id, refresh)
src/auth/       keychain token store, install id        src/stores/    zustand: session, cart, offline, push, app lock
src/offline/    SQLite outbox, drain, classify, snapshots, local stock delta, dev-offline switch
src/receipt/ src/printing/   receipt HTML → PDF/AirPrint; ESC/POS over BLE
src/components/ ui/ layout/ shell/ scanner/ …          src/theme/     tokens (no hex literals in screens)
src/i18n/       t(), locale switch — strings come from packages/i18n (never call t() at module scope)
e2e/  Maestro flows · store/  listing texts + screenshots · locales/  iOS InfoPlist strings · app.config.ts · eas.json
```

Shared logic is `@matgary/api-client`, `@matgary/domain`, `@matgary/i18n`. Full context: `mobile-dev-docs/`.
