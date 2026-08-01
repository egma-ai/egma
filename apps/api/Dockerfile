# syntax=docker/dockerfile:1
FROM node:24-alpine

RUN corepack enable
WORKDIR /app

# Manifests first, so editing source does not reinstall the world.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/ids/package.json packages/ids/
COPY packages/lint/package.json packages/lint/
RUN pnpm install --frozen-lockfile --filter "egma" --filter "@egma/api..."

COPY packages/ids packages/ids
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm exec tsc -b packages/ids packages/db apps/api

ENV NODE_ENV=production
EXPOSE 3100

# Migrations apply on boot, inside this process. There is no migration
# container and no manual step.
CMD ["node", "apps/api/dist/index.js"]
