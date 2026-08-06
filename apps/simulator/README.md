# The simulator

The service that conducts simulations. It claims simulation specs from the
control plane over outbound HTTP, conducts each one as a real conversation
— the persona on one side, the agent under test on the other — and reports
what happened — status transitions, transcript turns, measurements,
terminal facts — as it happens. It never touches the database and never
imports monorepo code: the versioned JSON contract in
`packages/simulation-contract` is its entire connection to the rest of
egma, which is also what lets this one app be Python inside a TypeScript
monorepo.

Three seams shape the inside, and each exists to be swapped without
touching the others:

- **The persona brain** (`persona.py`) — one component for every modality,
  forever. It composes the spec's persona traits and scenario instructions
  into a system prompt, takes the `human` side of the transcript turn by
  turn, and decides when the exchange is concluded.
- **The model client** (`model.py`) — where the persona's words come from.
  `scripted` walks the scenario deterministically and is what CI and the
  local story run on; `openai` speaks the OpenAI chat-completions shape to
  any provider, selected purely by configuration.
- **The platform plugs** (`plugs/`) — one component per connection type
  that alone knows how to reach and exchange turns with that platform.
  Everything else is plug-blind. The scripted counterpart — a fake
  platform whose agent answers from a script — is the first plug, and the
  reason the whole loop runs with no account and no network. To write a
  plug for a real platform, read the `plugs/__init__.py` docstring; it is
  the entire brief.

The speech legs — STT, TTS, the dual-channel recording, the measured audio
band — arrive with the voice plug work; a chat exchange needs none of
them. A spec naming a connection type the simulator holds no plug for is
refused out loud at claim time and reported not at all: the row stays the
control plane's to sweep.

## How it runs

The simulator **pulls**. It long-polls a claim endpoint declaring how much
capacity it has free, runs each claimed simulation as one asyncio task
(concurrency-capped, executor swappable by design), heartbeats every five
seconds per running simulation, and honors cancel directives that arrive
on heartbeat answers. It keeps zero inbound network surface: every arrow
points out.

A simulation ends one of five ways, each reported distinctly: the persona
concludes, the agent ends the exchange, the turn limit trips, the duration
limit trips (both limits report `limit_reached`, with a reason naming
which), or a cancel directive stops it. A limit ending is deliberate and
never the agent failing.

Reports are minted as events (ids and timestamps stamped once), written to
a local write-ahead log, then delivered in order; a resend replays the
same bytes, so the receiving side can dedup on event ids. Credentials from
specs exist only in memory, are handed only to the plug, and are scrubbed
from every log line — the report schema has no place to put them even by
accident.

## Running it locally

Both halves live here: the simulator, and the **workbench** — a dev/test
fake control plane that serves specs from fixture files and records
everything reported. [uv](https://docs.astral.sh/uv/) manages the
toolchain.

```bash
cd apps/simulator
uv sync

# Terminal 1: the workbench, holding the golden spec fixtures.
uv run egma-workbench --port 8085

# Terminal 2: the simulator, pointed at it.
EGMA_SIMULATOR_CONTROL_PLANE_URL=http://127.0.0.1:8085 \
uv run egma-simulator
```

The workbench prints one JSON line per observation — queued, the claim,
each heartbeat, each reported event — which is a simulation going
queued → claimed → running → completed, live. The two `scripted` fixtures
conduct whole conversations; the `retell` and `phone` fixtures are refused
with a clear log line, honestly, until their plugs land.
`GET /workbench/records` returns the same as JSON;
`POST /workbench/simulations/<id>/cancel` flags a cancel directive for the
next heartbeat; `POST /workbench/specs` queues another spec while
everything runs.

To hear the persona speak through a real model instead of the script, set
the model provider — conversations stop being deterministic, which is
exactly why CI never does this:

```bash
EGMA_SIMULATOR_MODEL_PROVIDER=openai \
EGMA_SIMULATOR_MODEL_NAME=gpt-4o-mini \
EGMA_SIMULATOR_MODEL_API_KEY=sk-... \
EGMA_SIMULATOR_CONTROL_PLANE_URL=http://127.0.0.1:8085 \
uv run egma-simulator
```

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
| `EGMA_SIMULATOR_MODEL_PROVIDER` | `scripted` | Where the persona's words come from: `scripted` or `openai`. |
| `EGMA_SIMULATOR_MODEL_BASE_URL` | `https://api.openai.com/v1` | The provider, for `openai` — any OpenAI-compatible endpoint. |
| `EGMA_SIMULATOR_MODEL_NAME` | (required for `openai`) | Which model to ask for. |
| `EGMA_SIMULATOR_MODEL_API_KEY` | (required for `openai`) | The provider key. Never logged. |
| `EGMA_SIMULATOR_WAL_DIR` | `.egma-simulator/wal` | Where report documents land before sending. |
| `EGMA_SIMULATOR_LOG_LEVEL` | `INFO` | The usual levels. |
| `EGMA_SIMULATION_CONTRACT_DIR` | auto-located | The contract package, when the repo layout isn't around it. |

## Tests

```bash
uv run --frozen ruff check src tests
uv run --frozen pytest
```

The acceptance suite is black-box at the contract seam: a real simulator
process against a real workbench over loopback HTTP, with every assertion
read from the workbench's records. A scripted persona converses with the
scripted counterpart and the reported transcript is checked turn for turn;
two fixture specs conduct two visibly different conversations; every
ending is reached and told apart, both limits included; cancel stops an
exchange mid-flight; capacity holds under load; a SIGKILLed simulator
stays honestly silent; and a planted credential appears in no log, report,
or write-ahead log. The whole suite runs on the scripted model client —
nothing can flake on a live model. `tests/test_contract_fixtures.py`
validates the golden fixtures in `packages/simulation-contract` from the
Python side — the other half of the drift guarantee the TypeScript suite
holds.

## Layout

```
src/egma_simulator/
  config.py       EGMA_SIMULATOR_* in, one frozen config out.
  contract.py     Locates the contract package; compiles and applies both schemas.
  client.py       The three outbound calls: claim, heartbeat, report.
  service.py      The claim loop, the capacity-capped executor, one running
                  simulation's lifecycle (conduct + heartbeat).
  persona.py      The persona brain: prompt composition, turn-taking,
                  deciding the exchange is concluded.
  model.py        The model-client seam: scripted (CI) and OpenAI-compatible.
  plugs/          The platform-plug seam. Its __init__ docstring is the
                  plug author's whole brief; scripted.py is the first plug.
  walk.py         One simulation's exchange: the turn loop, limits, cancel
                  delivery, and how each walk names its ending.
  reporting.py    Event minting, the write-ahead log, ordered delivery.
  redaction.py    Credential values registered once, scrubbed everywhere.
  workbench/      The fake control plane: same contract, fixture-fed,
                  records everything.
```
