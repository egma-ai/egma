#!/bin/sh
# Make `pnpm install --frozen-lockfile` able to build the one dependency that
# has to be compiled, and prove it can before the install starts.
#
# ## Why this exists
#
# `node-pty` is a real dependency of `apps/cli` — `apps/cli/test/support/pty.ts`
# drives the wizard through a real terminal, which is the only honest way to
# test a terminal experience — and it is named in `onlyBuiltDependencies`, so
# pnpm runs its install script.
#
# That script looks for a prebuilt binary and falls back to `node-gyp rebuild`.
# **There is nothing to fall back from on Linux.** node-pty 1.1.0 publishes
# prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64` and `win32-x64`, and
# for no Linux at all, so every Linux install of this repository compiles it —
# a laptop, GitHub's runner image, and this one alike. There is no cheaper path
# to take: the artefact does not exist to be fetched.
#
# What changed with the move to Blacksmith is only whether the compiler is
# there. GitHub's runner image ships `node-gyp` on the PATH, so the compile
# happened quietly and the install succeeded. Blacksmith's image, despite
# advertising parity, does not — and the failure arrives as `sh: 1: node-gyp:
# not found` from inside pnpm's install script, which names neither the package
# nor the missing toolchain.
#
# **So this is a runner-image gap, not a repository requirement.** A future
# reader on an image that already carries these will find every check below
# pass and nothing installed, and should leave it where it is rather than
# rediscover the failure.
#
# Nothing here makes the job non-deterministic: node-pty is compiled on every
# Linux run either way, because it always was. What is conditional is only
# whether a tool has to be fetched before that compile can happen.

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
