#!/usr/bin/env bash
#
# The calendar-is-full run, in one command.
#
#     ./fixtures/livekit-dumb-agent/calendar-is-full.sh
#
# It starts this agent as a real LiveKit worker, conducts one real
# simulation against it in a real room with `check_availability` answered
# by a mock tool, and hands back the transcript and the record showing
# which mock tool answered, with what, and how long it took — and the
# test's own job dispatch metadata read back out of the worker's log.
#
# Everything it needs is in one environment file — by default
# ~/.egma-livekit.env, the same one the README's two-step recipe sources.
# EGMA_LIVEKIT_ENV names a different one, or several separated by colons
# for a machine that keeps its LiveKit project and its speech providers in
# different files. They are read left to right, so a later one wins.
#
# Nothing here prints a credential. The worker writes its own log to a
# file whose path is named — only the path is printed, never the contents
# — and the file is left behind on purpose, so a run that went wrong can
# be read afterwards. Before it finishes, this scans that log for every
# credential it loaded and says so if it finds one; the simulation's own
# record, logs and write-ahead log are scanned by the test itself.

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
  if [ -n "$worker_pid" ]; then
    # The whole group, not the one process. `uv run` is a parent with the
    # agent underneath it, and a worker left alive here would still be
    # registered with the project — taking the next room somebody's test
    # opens, which is a failure two directories away from its cause.
    kill -- "-$worker_pid" 2>/dev/null || kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
}
trap stop_the_worker EXIT

echo "starting the dumb agent as a worker; its log is $worker_log"
cd "$here"
# Job control on for this one line, so the worker becomes a process group
# of its own and the trap above has a group to end.
set -m
uv run --frozen agent.py dev >"$worker_log" 2>&1 &
worker_pid=$!
set +m

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
#
# The status is kept rather than acted on, because the scan below has to
# run on the run that went *wrong*: a refusal quoting somebody else's
# words is the likeliest way a credential ever reaches a log, and that is
# a thing only a failed run produces.
#
# The worker's log path goes to the test, because half of what this run
# proves happens inside the *customer's* process: the test writes its own
# job dispatch metadata, egma puts it on the dispatch, and the only place
# the far side's reading of it is visible is the worker's own output. A
# test handed the path reads the line back and asserts it; one run by hand
# without the path says where to look instead.
conducted=0
cd "$root/apps/simulator"
EGMA_DUMB_AGENT_LOG="$worker_log" \
  uv run --frozen pytest tests/test_live_mock_tools.py -v -s -rs || conducted=$?

# The one surface the test cannot reach: the log of the *customer's* own
# process, which is where the SDK does its talking. Each value goes to
# grep down a pipe rather than on its command line, so it is never in
# anything as public as a process list — and only the variable's name is
# ever printed.
leaked=""
for name in LIVEKIT_API_KEY LIVEKIT_API_SECRET OPENAI_API_KEY EGMA_API_KEY \
  DEEPGRAM_API_KEY ELEVENLABS_API_KEY; do
  value="${!name:-}"
  [ -n "$value" ] || continue
  if printf '%s\n' "$value" | grep -qFf - "$worker_log"; then
    leaked="$leaked $name"
  fi
done
if [ -n "$leaked" ]; then
  echo "the agent's own log carried:$leaked — see $worker_log" >&2
  exit 1
fi
echo "no credential reached the agent's own log"

exit "$conducted"
