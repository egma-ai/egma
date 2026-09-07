#!/bin/sh
# Ensure the native build tools needed by node-pty are available before
# pnpm install. Install missing tools, then verify the commands can run.

set -eu

# What node-gyp needs underneath it. Checked by name rather than assumed from
# the image, because assuming the image is exactly what went wrong.
missing=""
for tool in g++ make python3; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done

if [ -n "$missing" ]; then
  echo "The C++ toolchain is incomplete on this runner; installing:$missing"
  sudo apt-get update
  # g++ and make come together in build-essential; python3 is its own package.
  sudo apt-get install --yes --no-install-recommends build-essential python3
fi

if ! command -v node-gyp >/dev/null 2>&1; then
  echo "node-gyp is not on this runner's PATH; installing it."
  npm install --global node-gyp \
    || sudo env "PATH=$PATH" npm install --global node-gyp

  # Installing it is not the same as being able to run it. Where npm puts a
  # global command is not always somewhere the PATH already looks, and
  # `pnpm install` runs in a step of its own — so the directory is added here
  # and handed forward to the steps that follow.
  globally="$(npm prefix --global)/bin"
  PATH="$globally:$PATH"
  export PATH
  if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$globally" >> "$GITHUB_PATH"
  fi
fi

# Proved here, where a failure is a sentence about the toolchain, rather than
# three steps later as a bare "not found" underneath a package name.
echo "--- what will compile node-pty ---"
node-gyp --version
python3 --version
make --version | head -1
g++ --version | head -1
