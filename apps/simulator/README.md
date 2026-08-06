# The simulator

The service that conducts simulations. It claims simulation specs from the
control plane over outbound HTTP, walks each one through an ephemeral
[Pipecat](https://github.com/pipecat-ai/pipecat) pipeline, and reports what
happened — status transitions, transcript turns, measurements, terminal
facts — as it happens. It never touches the database and never imports
monorepo code: the versioned JSON contract in
`packages/simulation-contract` is its entire connection to the rest of
egma, which is also what lets this one app be Python inside a TypeScript
monorepo.

What conducts a conversation today is the echo pipe: the persona's turns
are derived deterministically from the spec's scenario instructions and an
echo stands in for the agent under test. That is deliberate — it proves
the whole loop (claim, conduct, heartbeat, cancel, limits, report) without
a model or a platform on the other end. The persona brain and the real
platform plugs replace the echo without touching the loop.

## How it runs

The simulator **pulls**. It long-polls a claim endpoint declaring how much
capacity it has free, runs each claimed simulation as one asyncio task
(concurrency-capped, executor swappable by design), heartbeats every five
seconds per running simulation, and honors cancel directives that arrive
on heartbeat answers. It keeps zero inbound network surface: every arrow
points out.

Reports are minted as events (ids and timestamps stamped once), written to
a local write-ahead log, then delivered in order; a resend replays the
same bytes, so the receiving side can dedup on event ids. Credentials from
specs exist only in memory, are handed only to the pipeline, and are
scrubbed from every log line — the report schema has no place to put them
even by accident.

## Running it locally

Both halves live here: the simulator, and the **workbench** — a dev/test
fake control plane that serves specs from fixture files and records
everything reported. [uv](https://docs.astral.sh/uv/) manages the
toolchain.

```bash
cd apps/simulator
uv sync

# Terminal 1: the workbench, holding the golden chat spec.
uv run egma-workbench --port 8085

# Terminal 2: the simulator, pointed at it.
EGMA_SIMULATOR_CONTROL_PLANE_URL=http://127.0.0.1:8085 \
EGMA_SIMULATOR_ECHO_TURN_SECONDS=0.3 \
uv run egma-simulator
```

The workbench prints one JSON line per observation — queued, the claim,
each heartbeat, each reported event — which is a simulation going
queued → claimed → running → completed, live. `GET /workbench/records`
returns the same as JSON;
`POST /workbench/simulations/<id>/cancel` flags a cancel directive for the
next heartbeat; `POST /workbench/specs` queues another spec while
everything runs.

## Configuration

Everything arrives as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EGMA_SIMULATOR_CONTROL_PLANE_URL` | (required) | Where to claim, heartbeat, and report. |
| `EGMA_SIMULATOR_CAPACITY` | `4` | Most simulations conducted at once. |
| `EGMA_SIMULATOR_CLAIMANT` | `egma-simulator-<host>-<pid>` | The name stamped on claims. |
| `EGMA_SIMULATOR_HEARTBEAT_SECONDS` | `5` | Beat interval per running simulation. |
| `EGMA_SIMULATOR_CLAIM_WAIT_SECONDS` | `30` | How long one claim request may hang. |
| `EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS` | `120` | How long one report is resent before the log on disk becomes its only record. |
| `EGMA_SIMULATOR_ECHO_TURN_SECONDS` | `0` | Pacing between echo turns, for watching. |
| `EGMA_SIMULATOR_WAL_DIR` | `.egma-simulator/wal` | Where report documents land before sending. |
| `EGMA_SIMULATOR_LOG_LEVEL` | `INFO` | `DEBUG` opens up Pipecat's internals too. |
| `EGMA_SIMULATION_CONTRACT_DIR` | auto-located | The contract package, when the repo layout isn't around it. |

## Tests

```bash
uv run --frozen ruff check src tests
uv run --frozen pytest
```

The acceptance suite is black-box at the contract seam: a real simulator
process against a real workbench over loopback HTTP, with every assertion
read from the workbench's records. It covers the whole walk, cancel
mid-simulation, the capacity cap under load, a SIGKILLed simulator staying
honestly silent, and a planted credential appearing in no log, report, or
write-ahead log. `tests/test_contract_fixtures.py` validates the golden
fixtures in `packages/simulation-contract` from the Python side — the
other half of the drift guarantee the TypeScript suite holds.

## Layout

```
src/egma_simulator/
  config.py       EGMA_SIMULATOR_* in, one frozen config out.
  contract.py     Locates the contract package; compiles and applies both schemas.
  client.py       The three outbound calls: claim, heartbeat, report.
  service.py      The claim loop, the capacity-capped executor, one running
                  simulation's lifecycle (conduct + heartbeat).
  pipe.py         The Pipecat pipeline a simulation walks; the echo agent,
                  turn recorder, limits, and cancel delivery.
  reporting.py    Event minting, the write-ahead log, ordered delivery.
  redaction.py    Credential values registered once, scrubbed everywhere.
  workbench/      The fake control plane: same contract, fixture-fed,
                  records everything.
```
