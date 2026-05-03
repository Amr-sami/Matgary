# Matgary

Multi-tenant POS / inventory SaaS. Originally a single-shop Next.js app
(Corner Store) on Firebase; migrated to a tenant-isolated PostgreSQL backend
with Auth.js. Each signed-up shop gets its own categories, attributes, brands,
products, sales, returns, expenses, and WhatsApp settings — fully segregated
in the same database via app-level scoping plus Postgres Row-Level Security.

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind 4
- PostgreSQL 16 via Drizzle ORM
- Auth.js v5 (Credentials provider, JWT sessions, bcryptjs)
- WhatsApp Green API (per-tenant credentials, AES-256-GCM at rest)
- Vitest for the tenant-isolation test suite

## Local setup

Prereqs: Node 20+, Docker, npm.

```bash
# 1. Configuration — fill DATABASE_URL, AUTH_SECRET, SECRET_KEY
cp .env.example .env

# 2. Postgres in Docker. Boots a non-superuser app role on first run so RLS
#    policies actually fire against application traffic.
npm run db:up

# 3. Dependencies
npm install

# 4. Apply migrations (uses the admin DATABASE_URL)
npm run db:migrate

# 5. Dev server
npm run dev
```

Open <http://localhost:3000> → /signup → onboarding picks **"Like Corner
Store"** (seeds the original 3 categories + gender attribute + watch brand
list) or **"Start blank"** (define your own from Settings).

## Tests

```bash
npm test          # one-shot (vitest run)
npm run test:watch
```

The `tests/isolation.test.ts` suite is the load-bearing safety net — it
proves tenant A cannot see, edit, or delete tenant B's products /
categories / brands / sales / returns / expenses, and that RLS hides every
row when `app.tenant_id` is unset.

## Database commands

| Script | What it does |
|---|---|
| `npm run db:up` | `docker compose up -d postgres` |
| `npm run db:down` | `docker compose down` |
| `npm run db:logs` | follow Postgres logs |
| `npm run db:psql` | open a psql shell as the admin role |
| `npm run db:generate` | generate a new Drizzle migration from `lib/db/schema.ts` |
| `npm run db:migrate` | apply pending migrations |
| `npm run db:studio` | open `drizzle-kit studio` |

## Roles

Two Postgres roles share one database:

- `matgary` — superuser, owns the schema, used by migrations only.
- `matgary_app` — `NOSUPERUSER NOBYPASSRLS`, used by the running app.
  This is what makes RLS effective; superusers bypass it.

The init SQL at `infra/init-postgres.sql` creates the app role on a fresh
container. If you nuke the volume, the init script runs again automatically.

## Project structure

```
app/                Next.js routes (auth pages under (auth)/, API under api/)
components/         UI — preserves the original Corner Store cream/gold theme
hooks/              Client hooks (useProducts, useCategories, useSales, …)
lib/
  auth.ts           Full Node-runtime Auth.js config
  auth.config.ts    Edge-safe config used by middleware
  crypto.ts         AES-256-GCM encrypt/decrypt for the Green API token
  db/
    index.ts        Drizzle client + withTenant() helper (sets app.tenant_id)
    schema.ts       All tables + relations + RLS migrations live here
    migrations/     Generated + hand-written SQL migrations
  repo/             Server-only data access (catalog, operations, settings)
  api/              Client-side fetch wrappers for the routes
  seeds/            Per-tenant preset seeders (cornerstore.ts)
infra/              Docker init SQL
tests/              Vitest — tenant isolation
```

## Deployment

Not yet wired. Production target requires a managed Postgres with the same
two roles, a real `AUTH_SECRET` and `SECRET_KEY`, and a way to run
`npm run db:migrate` on deploy. Deferred from v1.
