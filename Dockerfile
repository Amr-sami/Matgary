# syntax=docker/dockerfile:1.7
#
# Production image for the matgary Next.js app. Multi-stage so the final
# layer holds only what's needed at runtime: the standalone server, public
# assets, and node_modules that survived the prune.
#
# Build:    docker build -t matgary-app:latest .
# Run:      docker run --rm -p 3000:3000 \
#               -e DATABASE_URL=... -e APP_DATABASE_URL=... \
#               -e AUTH_SECRET=... -e SECRET_KEY=... \
#               matgary-app:latest

FROM node:20-alpine AS deps
WORKDIR /app
# libc6-compat keeps native deps (bcryptjs, sharp via Next/image, postgres-js
# stream helpers) happy on Alpine.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
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
RUN npm run build

# Schema provisioning. The runner stage below carries only the ~26 packages
# Next's tracer kept for the standalone server — no tsx, no drizzle-orm — so
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
#   docker compose -f docker-compose.prod.yml run --rm migrate
#   docker compose -f docker-compose.prod.yml run --rm --entrypoint \
#     "npx tsx scripts/seed-demo-template.ts" migrate
FROM node:20-alpine AS migrator
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.scripts.json drizzle.config.ts ./
COPY lib ./lib
COPY scripts ./scripts
CMD ["npx", "tsx", "lib/db/migrate.ts"]

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Drop root for the runtime user. UID 1001 is conventional for "node-app".
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone output already includes a trimmed node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations are needed when the container boots a brand-new DB (or one that
# is behind on schema). Bundle them so `npm run db:migrate` works inside.
COPY --from=builder --chown=nextjs:nodejs /app/lib/db ./lib/db
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts ./drizzle.config.ts

USER nextjs
EXPOSE 3000

# Standalone build emits server.js at the project root.
CMD ["node", "server.js"]
