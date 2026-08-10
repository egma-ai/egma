#!/usr/bin/env bash
#
# The calendar-is-full run, in one command.
#
#     ./fixtures/livekit-dumb-agent/calendar-is-full.sh
#
# It starts this agent as a real LiveKit worker, conducts one real
# simulation against it in a real room with `check_availability` answered
# by a mock tool, and hands back the transcript and the record showing
# which mock tool answered, with what, and how long it took.
#
# Everything it needs is in one environment file — by default
# ~/.egma-livekit.env, the same one the README's two-step recipe sources.
# EGMA_LIVEKIT_ENV names a different one, or several separated by colons
# for a machine that keeps its LiveKit project and its speech providers in
# different files. They are read left to right, so a later one wins.
#
# Nothing here prints a credential. The worker's own log is written to a
# file whose path is named; only that path is printed, never its contents.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
env_files="${EGMA_LIVEKIT_ENV:-$HOME/.egma-livekit.env}"

# How long the worker is given to register with LiveKit before this gives
# up. Registration is a round trip to the project and a moment of Silero
# loading itself, so it is seconds rather than instant — and a wait
# without a wall is a script that hangs when a URL is wrong.
readonly REGISTER_SECONDS=90

IFS=':' read -ra named <<<"$env_files"
for env_file in "${named[@]}"; do
  if [ ! -f "$env_file" ]; then
    echo "no environment file at $env_file" >&2
    echo "copy $here/.env.example to it and fill it in, or set EGMA_LIVEKIT_ENV" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
done

worker_log="$(mktemp -t egma-dumb-agent-XXXXXX.log)"
worker_pid=""

stop_the_worker() {
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
}
trap stop_the_worker EXIT

echo "starting the dumb agent as a worker; its log is $worker_log"
(cd "$here" && uv run --frozen agent.py dev) >"$worker_log" 2>&1 &
worker_pid=$!

waited=0
until grep -q "registered worker" "$worker_log" 2>/dev/null; do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "the worker stopped before it registered; see $worker_log" >&2
    exit 1
  fi
  if [ "$waited" -ge "$REGISTER_SECONDS" ]; then
    echo "the worker did not register within ${REGISTER_SECONDS}s; see $worker_log" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "the worker is registered; conducting the simulation"

# -s so the transcript and the record reach the terminal — that output is
# the whole point of this command, watching the promise work rather than
# reading a line that says a test passed. -rs so that a run which skips
# says which value it was short of, rather than passing quietly.
cd "$root/apps/simulator"
uv run --frozen pytest tests/test_live_mock_tools.py -v -s -rs
