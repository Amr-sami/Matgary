# @matgary/mobile

The React Native (Expo) client for **Matgary / TheStoro**, served by the same
backend as the web app at `apps/web` — not a second server, not a rewrite.

## Run it

```bash
# 1. backend (separate terminal, from the repo root)
cd apps/web && npx next dev -p 3001

# 2. point the app at your machine
cp .env.example .env        # then set EXPO_PUBLIC_API_URL

# 3. the app
npx expo start
```

`EXPO_PUBLIC_API_URL` is optional on a simulator — the client derives the host
from whatever machine served the bundle (`src/api/client.ts`). A physical device
needs it set to the Mac's LAN IP.

## Layout

```
src/
  app/         expo-router file tree. (public) = signed out, (app) = signed in.
  api/         binds @matgary/api-client to this device
  auth/        keychain-backed token store, install id
  stores/      zustand session state
  components/  UI primitives and screen pieces
  theme/       design tokens measured from the web app
```

Shared, platform-free logic lives in `packages/*` and is imported as
`@matgary/api-client`, `@matgary/domain`, `@matgary/i18n`.

## Known constraints on this machine

- **`npx expo run:ios` does not build.** `expo-modules-jsi@57.1.0` fails to
  compile under Xcode 26.3 / Swift 6.2.4. Use Expo Go (`npx expo start --go`)
  until Expo ships a fix or an older Xcode is available.
- **Expo Go does not apply config plugins**, so `forcesRTL` from
  `expo-localization` is inert there and the layout renders LTR. RTL needs a
  dev-client build.
- **`experiments.typedRoutes` is off.** The CLI's route type generator resolves
  `expo-router` from the repo root, where npm has not hoisted it.

Full context: `mobile-dev-docs/` at the repo root.
