# syntax=docker/dockerfile:1.7

# Multi-stage build for a Next.js 16 (App Router) standalone server.
# Image is run on Cloud Run; we listen on $PORT (8080) as 0.0.0.0.

ARG NODE_VERSION=24-alpine

# ---------- Stage 1: deps ----------
# Install production + dev deps with pnpm. Cached on package.json + pnpm-lock.yaml only.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# pnpm via corepack (bundled with Node 24). Pin to whatever the lockfile uses.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Alpine needs libc6-compat for some Node native modules (sharp, etc.).
RUN apk add --no-cache libc6-compat

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Note: BuildKit cache mounts removed for compatibility with Cloud Build's
# default Docker daemon. With BuildKit available locally we'd add
# `--mount=type=cache,target=/root/.pnpm-store` to speed re-builds.
RUN pnpm install --frozen-lockfile

# ---------- Stage 2: builder ----------
# Compile the app with `pnpm build`. NEXT_PUBLIC_* must be present here so they
# get inlined into the client bundle (they cannot be supplied at runtime).
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Build-time public env. Cloud Build passes these via --build-arg from
# substitutions / Secret Manager (see cloudbuild.yaml).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_PUSHER_KEY
ARG NEXT_PUBLIC_PUSHER_CLUSTER
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_PUSHER_KEY=$NEXT_PUBLIC_PUSHER_KEY \
    NEXT_PUBLIC_PUSHER_CLUSTER=$NEXT_PUBLIC_PUSHER_CLUSTER \
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_API_KEY \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build

# ---------- Stage 3: runner ----------
# Minimal final image: only the standalone server, static assets, and public/.
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Non-root user (uid/gid 1001).
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# `output: 'standalone'` produces .next/standalone with a tiny server.js plus
# the necessary node_modules subset. Static assets and public/ must be copied
# alongside it so server.js can serve them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
