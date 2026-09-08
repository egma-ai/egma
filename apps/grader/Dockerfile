# syntax=docker/dockerfile:1
FROM node:24-alpine

RUN corepack enable
WORKDIR /app

# Manifests first, so editing source does not reinstall the world.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/grader/package.json apps/grader/
COPY packages/db/package.json packages/db/
COPY packages/ingestion/package.json packages/ingestion/
COPY packages/ids/package.json packages/ids/
COPY packages/metrics/package.json packages/metrics/
COPY packages/provider-credentials/package.json packages/provider-credentials/
COPY packages/simulation-contract/package.json packages/simulation-contract/
RUN --mount=type=bind,target=/workspace \
    if [ -f /workspace/ee/package.json ]; then \
      mkdir -p ee && cp /workspace/ee/package.json ee/; \
    fi
RUN pnpm install --frozen-lockfile --filter "egma" --filter "@egma/grader..."

COPY packages/ids packages/ids
COPY packages/metrics packages/metrics
COPY packages/provider-credentials packages/provider-credentials
COPY packages/simulation-contract packages/simulation-contract
COPY packages/db packages/db
COPY packages/ingestion packages/ingestion
RUN --mount=type=bind,target=/workspace \
    if [ -f /workspace/ee/package.json ]; then cp -R /workspace/ee/. ee/; fi
COPY apps/grader apps/grader
RUN pnpm --filter @egma/ee --if-present build \
    && pnpm exec tsc -b packages/ids packages/provider-credentials packages/db packages/ingestion apps/grader

ENV NODE_ENV=production

# No EXPOSE, and there never will be one: the service claims its work rather
# than being sent it, so it has no inbound surface at all. The migrations are
# not applied here either — the API applies them on boot and this waits for it.
#
# Not root, deliberately: this process reads untrusted conversations and holds
# the encryption key while it does, so it runs as the image's own unprivileged
# user and a compromise stays inside that user's reach.
RUN mkdir -p /var/lib/egma/grader-ingestion && chown node:node /var/lib/egma/grader-ingestion
USER node
# `--import` loads the telemetry module before the entry module — see the
# API's Dockerfile; with the telemetry flag unset it checks the flag and does
# nothing.
CMD ["node", "--import", "./apps/grader/dist/telemetry.js", "apps/grader/dist/index.js"]
