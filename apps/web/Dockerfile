# syntax=docker/dockerfile:1
FROM node:24-alpine AS build

RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/ids/package.json packages/ids/
COPY packages/lint/package.json packages/lint/
RUN pnpm install --frozen-lockfile --filter "@egma/web..."

COPY apps/web apps/web

# Where this process proxies the API's paths to. Next resolves rewrites into
# the build, so this is fixed here rather than at start-up. The telemetry
# values are also build inputs because Next writes NEXT_PUBLIC_* into the
# browser bundle. The PostHog project token is intentionally public and cannot
# read data back.
ARG EGMA_API_ORIGIN=http://api:3100
ARG EGMA_TELEMETRY=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
ENV EGMA_API_ORIGIN=${EGMA_API_ORIGIN}
ENV EGMA_TELEMETRY=${EGMA_TELEMETRY}
ENV NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY}
ENV NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST}
RUN pnpm --filter @egma/web build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

EXPOSE 3101
CMD ["node", "apps/web/server.js"]
