#!/usr/bin/env bash
set -euo pipefail

# Exit 1 only for an absent tag. Access and registry errors stop publication.
response=$(aws ecr batch-get-image --repository-name "$1" \
  --image-ids "imageTag=$2" --output json)
if jq -e '(.images | length) == 1 and (.failures | length) == 0' <<<"$response" >/dev/null; then
  exit 0
fi
if jq -e '(.images | length) == 0 and (.failures | length) == 1 and
  .failures[0].failureCode == "ImageNotFound"' <<<"$response" >/dev/null; then
  exit 1
fi
echo "ECR did not return an image or an unambiguous missing tag for $1:$2." >&2
exit 2
