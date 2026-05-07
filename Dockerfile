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
RUN npm run build

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
