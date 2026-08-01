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
RUN pnpm --filter @egma/web build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3101
CMD ["node", "apps/web/server.js"]
