#!/bin/bash
# Replace what a box is running with a named build.
#
#   ./deploy.sh <image-tag>        # tag defaults to `latest`
#
# For an egma running on one machine against managed stores — the shape
# `docker-compose.managed.yml` describes. It is what
# `.github/workflows/deploy-platform.yml` invokes over SSM, and it is equally a
# script to run by hand when CI is not an option and nobody wants to drive a
# deployment through a browser at three in the morning.
#
# **It names no deployment.** The account comes from whatever credential the
# machine already holds, and the region from the environment. What it deploys —
# which database, which trace store, which bucket — is decided entirely by the
# settings file beside it, which this script does not write. See
# `settings.sh.example`.
#
# It assumes only that the machine can reach ECR and that `docker compose` is
# installed. A deployment keeping its images elsewhere replaces the login and
# the registry, and nothing else here changes.
set -euo pipefail

TAG="${1:-latest}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The registry is derived rather than configured: it is this account's own, in
# this region, and deriving it means one less value to keep in step.
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${EGMA_REGISTRY:-${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com}"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

cd "$HERE"

# Settings are assembled fresh on every deployment, so changing one and
# deploying is enough — there is no separate step to remember and no rebuild.
# The script that assembles them belongs to the deployment, not to egma, so it
# is expected beside this one and is not in this repository.
if [ -x ./settings.sh ]; then
  ./settings.sh
else
  echo "No ./settings.sh beside this script." >&2
  echo "It writes the .env this deployment runs on. See settings.sh.example." >&2
  exit 1
fi

# The registry and tag join the assembled settings rather than being exported,
# so a `docker compose` run by hand afterwards sees exactly what the deployment
# saw rather than resolving to something else.
sed -i '/^EGMA_REGISTRY=/d;/^EGMA_IMAGE_TAG=/d' ./.env
printf 'EGMA_REGISTRY=%s\nEGMA_IMAGE_TAG=%s\n' "$REGISTRY" "$TAG" >> ./.env

docker compose pull
docker compose up -d --wait --wait-timeout 300
docker compose ps
