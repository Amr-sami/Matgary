# Onboarding tour screenshots

The step-4 tour ships **two sets** of screenshots — Arabic + English — under:

```
public/onboarding-tour/
  ar/{slug}.png        ← shown when user.locale = 'ar'
  en/{slug}.png        ← shown when user.locale = 'en'
```

The tour Image picks the folder via `useLocale()`, so it follows the user's
language preference automatically.

## Slide order (13 total)

| #  | Slug          | Route          |
|----|---------------|----------------|
| 1  | `dashboard`   | `/`            |
| 2  | `inventory`   | `/inventory`   |
| 3  | `add-product` | `/add-product` |
| 4  | `sales`       | `/sales`       |
| 5  | `customers`   | `/customers`   |
| 6  | `reports`     | `/reports`     |
| 7  | `purchases`   | `/purchases`   |
| 8  | `suppliers`   | `/suppliers`   |
| 9  | `tasks`       | `/tasks`       |
| 10 | `expenses`    | `/expenses`    |
| 11 | `team`        | `/team`        |
| 12 | `activity`    | `/activity`    |
| 13 | `settings`    | `/settings`    |

## Refreshing all 26 screenshots

```sh
# 1. Dev server up on https://192.168.1.61:3000 (or set TOUR_BASE_URL)
pnpm dev:https

# 2. Seed a tenant with rich data (24 products, 90 sales across 30 days,
#    15 customers, 3 suppliers, 3 POs, 4 tasks, 5 expenses, 2 staff
#    accounts, 8 activity events). Logs in as amr@matgary.local.
pnpm db:seed:rich

# 3. Capture — runs the tour TWICE (once with users.locale='ar', once
#    with 'en'), flipping the locale + busting the Redis JWT cache
#    between runs.
pnpm tour:screenshots
```

The capture script:
- Flips `users.locale` in Postgres for `amr@matgary.local`
- Bumps `token_version` to invalidate any cached JWT
- DELs `matgary:<env>:v1:g:userctx:<userId>` in Redis so the JWT
  callback rebuilds with the new locale (the cache TTL is 60s, so
  without this we'd see the wrong language for the first minute)
- Signs in fresh, snaps all 13 routes at 1600 × 1000 @ 2× DPI
- Always restores `users.locale = 'ar'` in the `finally` block so
  manual testing isn't disturbed

## Manual replacement

Drop your own PNGs into the matching locale folder — keep the filenames + 16 : 10 ratio. If a file is missing, the slide falls back to an animated mock illustration (gradient + Phosphor icon).
