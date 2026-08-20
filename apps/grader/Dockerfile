# syntax=docker/dockerfile:1
FROM node:24-alpine

RUN corepack enable
WORKDIR /app

# Manifests first, so editing source does not reinstall the world.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/grader/package.json apps/grader/
COPY packages/db/package.json packages/db/
COPY packages/ids/package.json packages/ids/
COPY packages/provider-credentials/package.json packages/provider-credentials/
COPY packages/simulation-contract/package.json packages/simulation-contract/
RUN pnpm install --frozen-lockfile --filter "egma" --filter "@egma/grader..."

COPY packages/ids packages/ids
COPY packages/provider-credentials packages/provider-credentials
COPY packages/simulation-contract packages/simulation-contract
COPY packages/db packages/db
COPY apps/grader apps/grader
RUN pnpm exec tsc -b packages/ids packages/provider-credentials packages/db apps/grader

ENV NODE_ENV=production

# No EXPOSE, and there never will be one: the service claims its work rather
# than being sent it, so it has no inbound surface at all. The migrations are
# not applied here either — the API applies them on boot and this waits for it.
#
# Not root, deliberately: this process reads untrusted conversations and holds
# the encryption key while it does, so it runs as the image's own unprivileged
# user and a compromise stays inside that user's reach.
USER node
# `--import` loads the telemetry module before the entry module — see the
# API's Dockerfile; with the telemetry flag unset it checks the flag and does
# nothing.
CMD ["node", "--import", "./apps/grader/dist/telemetry.js", "apps/grader/dist/index.js"]
