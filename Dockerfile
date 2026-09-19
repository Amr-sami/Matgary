# syntax=docker/dockerfile:1.7
#
# Production image for the matgary Next.js app. Multi-stage so the final
# layer holds only what's needed at runtime: the standalone server, public
# assets, and node_modules that survived the prune.
#
# MONOREPO LAYOUT. The web app lives at apps/web, and npm workspaces hoist
# every dependency to the repo-root node_modules. The build context is still
# the repo root, but nothing is at the root any more except the workspace
# manifests — so the paths below are all `apps/web/...`.
#
# Build:    docker build -t matgary-app:latest .
# Run:      docker run --rm -p 3000:3000 \
#               -e DATABASE_URL=... -e APP_DATABASE_URL=... \
#               -e AUTH_SECRET=... -e SECRET_KEY=... \
#               matgary-app:latest

# node 22: the root package.json says engines.node >=22 (packages/i18n's tests
# use --experimental-strip-types, 22.6+), and node 20 made npm ci print
# EBADENGINE for the root manifest on every build.
FROM node:22-alpine AS deps
WORKDIR /repo
# libc6-compat keeps native deps (bcryptjs, sharp via Next/image, postgres-js
# stream helpers) happy on Alpine.
RUN apk add --no-cache libc6-compat
# Both manifests are required: npm ci in a workspace resolves the whole graph
# from the root lockfile, and refuses to run if a workspace package.json named
# in the lockfile is absent.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
# Workspace packages. npm links each workspace as node_modules/@matgary/<name>
# -> ../../packages/<name>, and that link — not the tsconfig `@matgary/*`
# path, whose `../../packages/*/src` shape covers neither deep imports like
# @matgary/domain/money/cart-math nor the `./ar` / `./en` export-map entries
# of @matgary/i18n — is how the app resolves them. The root lockfile knows all
# three (package-lock.json: node_modules/@matgary/{domain,i18n,api-client}).
# apps/web needs domain statically (lib/sales/cart-math.ts, lib/sentry/scrub.ts)
# and i18n dynamically (lib/i18n/get-dictionary.ts imports @matgary/i18n/ar and
# /en); api-client is test-only but is a workspace all the same. Without a
# manifest here npm ci never creates that link and `next build` fails with
# "Module not found: Can't resolve '@matgary/<name>/...'".
COPY packages/domain/package.json ./packages/domain/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/api-client/package.json ./packages/api-client/
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Next 16 evaluates module-level code during page-data collection. Modules like
# lib/db/index.ts throw if their env vars are missing, which breaks the build
# even though no real connection is made. Provide harmless placeholders here
# (build-only; the runner stage gets real values from compose env_file).
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV APP_DATABASE_URL=postgres://build:build@localhost:5432/build
ENV AUTH_SECRET=build-placeholder-secret
ENV SECRET_KEY=build-placeholder-secret
RUN npm run build --workspace @matgary/web

# Schema provisioning. The runner stage below carries only the packages Next's
# tracer kept for the standalone server — no tsx, no drizzle-orm — so
# `npm run db:migrate` cannot run there despite the migrations being bundled.
# This stage keeps the full dependency tree instead, and is the only supported
# way to create or upgrade a database:
#
#   docker compose -f docker-compose.prod.yml run --rm migrate
#
# Doubles as the maintenance image: the seed scripts (notably
# scripts/seed-demo-template.ts, without which the "Browse the demo store"
# button fails with TEMPLATE_MISSING) import @/ path aliases across lib/, so
# tsconfig.json and the full lib/ + scripts/ tree come along. All source, no
# build output — it adds a couple of MB.
#
# Commands run from /repo/apps/web so the @/ alias and dotenv both resolve.
#
#   docker compose -f docker-compose.prod.yml run --rm migrate
#   docker compose -f docker-compose.prod.yml run --rm --entrypoint \
#     "npx tsx scripts/seed-demo-template.ts" migrate
FROM node:22-alpine AS migrator
WORKDIR /repo
RUN apk add --no-cache libc6-compat
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json ./
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.scripts.json \
     apps/web/drizzle.config.ts ./apps/web/
COPY apps/web/lib ./apps/web/lib
COPY apps/web/scripts ./apps/web/scripts
WORKDIR /repo/apps/web
CMD ["npx", "tsx", "lib/db/migrate.ts"]

FROM node:22-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Drop root for the runtime user. UID 1001 is conventional for "node-app".
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone output already includes a trimmed node_modules. In a workspace it
# preserves the repo shape: node_modules at the root of the copied tree, and
# the server entrypoint at apps/web/server.js.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

# Migrations are needed when the container boots a brand-new DB (or one that
# is behind on schema). Bundle them so the migrator stage's output is
# reproducible from the same image tag.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/lib/db ./apps/web/lib/db
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/drizzle.config.ts ./apps/web/drizzle.config.ts

# User uploads (product photos, team photos, receipt logos — lib/uploads.ts)
# land under UPLOADS_DIR. WORKDIR /repo is root-owned 755 and the COPY --chown
# lines above only cover the copied subtrees, so without this the first upload
# dies at mkdir with EACCES. Create the directory owned by the runtime user
# BEFORE dropping root: docker-compose.prod.yml mounts the named volume
# matgary_uploads at this path, and a named volume copies the image
# directory's ownership on first mount, so it comes up writable by uid 1001
# with no host-side chown.
ENV UPLOADS_DIR=/repo/uploads
RUN mkdir -p /repo/uploads && chown nextjs:nodejs /repo/uploads

USER nextjs
EXPOSE 3000

# Standalone emits server.js at the workspace's path inside the output tree.
CMD ["node", "apps/web/server.js"]
