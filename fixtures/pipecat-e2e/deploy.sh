#!/usr/bin/env bash
# Deploy the e2e bot to Pipecat Cloud with a cloud build.
#
# Stages a clean build context in .build/ (the bot's files and the Egma SDK
# wheel built from sdks/python), then runs `pipecat cloud deploy` with
# pcc-deploy.toml. Extra arguments go to the deploy, for example
# `--min-agents 0` or `--force`.
#
#   EGMA_SDK_WHEEL=off ./deploy.sh   deploys without the SDK
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sdk="$here/../../sdks/python"
build="$here/.build"

rm -rf "$build"
mkdir -p "$build/wheels"
# A cloud build uploads files only, so an empty wheels/ would vanish.
echo "Egma SDK wheels staged by deploy.sh" > "$build/wheels/README"
cp "$here/Dockerfile" "$here/pyproject.toml" "$here/uv.lock" \
  "$here/bot.py" "$here/flow_handlers.py" "$here/store.py" "$here/flow.yaml" "$build/"

if [ "${EGMA_SDK_WHEEL:-on}" != "off" ]; then
  (cd "$sdk" && uv build --wheel --out-dir "$build/wheels")
  echo "Staged the Egma SDK wheel: $(cd "$build/wheels" && ls ./*.whl)"
else
  echo "Deploying without the Egma SDK"
fi

cd "$here"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
# The Pipecat CLI exits 0 when the cloud build fails, so read its output too.
pipecat cloud deploy --build-dir .build --yes "$@" 2>&1 | tee "$log"
if grep -q -E "Build failed|Error" "$log"; then
  echo "deploy.sh: the deploy reported an error" >&2
  exit 1
fi
