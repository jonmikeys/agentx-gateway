# syntax=docker/dockerfile:1.7

# ---- Base ----
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- Dependencies (cached on lockfile) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- Runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MEDIA_STORAGE_DIR=/data/media

RUN addgroup -S -g 1001 gateway && adduser -S -u 1001 -G gateway gateway \
    && mkdir -p /data/media && chown -R gateway:gateway /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --from=build --chown=gateway:gateway /app/.next/standalone ./
COPY --from=build --chown=gateway:gateway /app/.next/static ./.next/static
COPY --from=build --chown=gateway:gateway /app/public ./public
# SQL migrations are applied automatically at server start (instrumentation.ts).
COPY --from=build --chown=gateway:gateway /app/drizzle ./drizzle

USER gateway
EXPOSE 3000
VOLUME ["/data/media"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
