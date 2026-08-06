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

Five seams shape the inside, and each exists to be swapped without
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
  Everything else is plug-blind. Two fake platforms ship as the first
  plugs — the scripted counterpart, whose agent answers from a script over
  chat, and the loopback counterpart, which answers the same script in
  audio — and they are why the whole loop runs with no account and no
  network. `retell` is the first real one: it speaks Retell's chat API,
  driven entirely by the spec's connection block, and adding it changed
  nothing outside `plugs/`. `phone` dials a number — provider-blind by
  construction, because the telephone network neither knows nor cares
  what answers, so a Retell agent, a Vapi agent and a person behind a
  number are all one plug. To write the next, read the
  `plugs/__init__.py` docstring; it is the entire brief.
- **The media backends** (`media/`) — how a phone call's audio travels.
  One driver per bridge, behind a four-method seam: open a session, dial,
  wait until somebody answers, tear it down. `livekit` places real calls
  over a SIP trunk the deployment brings from any carrier; `scripted` is
  the local stand-in that answers a call nobody placed, and is what CI
  runs on. Nothing above the seam — the plug's lifecycle, the pipeline,
  the recording, the report — learns which one ran, so another bridge is
  one new module and one registry line. To write one, read the
  `media/__init__.py` docstring; it is the entire brief.
- **The speech legs** (`speech.py`) — a voice simulation is a chat one
  with two more legs: the persona's words spoken into audio, the agent's
  audio read back into words. Which pair fills them is configuration read
  at assembly and nowhere else — a deterministic pair, or ElevenLabs
  speaking and Deepgram listening, each chosen on its own. The
  deterministic pair is the default everywhere and what CI speaks and
  listens with: no account, no network, no downloaded corpus, and the
  same words out that went in. Nothing above the assembly learns which
  pair it got, which is what keeps a future speech-to-speech persona a
  different leg-set rather than a rewrite.

One pipeline is assembled per simulation from its own spec and torn down
after (`pipeline.py`). Modality selects the legs and nothing else: a chat
simulation is the plug and the brain, and a voice one is the same plug and
the same brain with the speech legs between them, recording as they go. A
spec naming a connection type the simulator holds no plug for is refused
out loud at claim time and reported not at all: the row stays the control
plane's to sweep.

## What a voice simulation reports

The same transcript, ending and measurements a chat simulation reports,
plus what only audio can owe:

- **The measured band.** Connections declare a band; platforms carry what
  they can. What the record keeps is the band the audio actually flowed
  at, stamped at execution — connections are editable and unversioned, so
  a band copied from one would let a later edit rewrite what an old result
  meant. 8 kHz telephony and 48 kHz WebRTC are different units: scores
  across them are not comparable.
- **A dual-channel recording**, the persona on channel 0 and the agent on
  channel 1, so either side can be heard alone when a transcript looks
  wrong. It is written through the blob seam (`blob.py`) — an interface
  with a filesystem-backed default, so a first voice simulation needs no
  object storage running — and the report carries only the reference,
  never the bytes and never a URL.
- **Per-turn measurements**, all read from the audio itself rather than
  from a clock: `time_to_first_word` (how long the agent was quiet before
  speaking), `agent_speech_duration` and `persona_speech_duration`.

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
conduct whole exchanges over chat and the `loopback` one conducts a spoken
one, leaving a real `.wav` under `EGMA_SIMULATOR_BLOB_DIR` that you can
open and listen to a channel at a time; the `retell` fixture really does
dial Retell and fails at the door, because the key in a fixture is a
placeholder; the `phone` fixture tries to place a real call and fails at
the door too, naming the LiveKit variable it wanted, because a local run
configures no bridge to place one through.
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

To hear a real voice instead of the test tone, name the speech providers.
The `.wav` the `loopback` fixture leaves behind is then genuinely spoken
audio on one channel, and the transcript's agent turns are what a real
transcriber made of the other. Each leg is chosen on its own, so a real
voice with scripted ears is one variable:

```bash
EGMA_SIMULATOR_TTS_PROVIDER=elevenlabs \
EGMA_SIMULATOR_ELEVENLABS_API_KEY=... \
EGMA_SIMULATOR_STT_PROVIDER=deepgram \
EGMA_SIMULATOR_DEEPGRAM_API_KEY=... \
EGMA_SIMULATOR_CONTROL_PLANE_URL=http://127.0.0.1:8085 \
uv run egma-simulator
```

Which voice the persona speaks with comes from its own authored traits —
a `voice` block naming a `voiceId` — and a persona naming none speaks
with a default English voice. A voice id belongs to the provider it was
authored for, so a `voice` block naming a *different* provider than the
one configured is treated as naming none: the default English voice
speaks and a log line says why, rather than the simulation failing on a
timbre. A block naming a `voiceId` and no provider is authored for
whichever deployment runs it, and is used as written. Setting neither
variable leaves everything exactly as it was: the scripted pair, no
account, no network.

To dial a real phone number, point the simulator at a LiveKit server and
give it a SIP trunk. The trunk is yours, from any carrier — either one
already stored in LiveKit or the inline fields below — and the same three
LiveKit variables serve a self-hosted server and LiveKit Cloud. Real
speech providers belong with it: a call spoken in the test tone reaches a
real agent as noise.

```bash
EGMA_SIMULATOR_LIVEKIT_URL=wss://... \
EGMA_SIMULATOR_LIVEKIT_API_KEY=... \
EGMA_SIMULATOR_LIVEKIT_API_SECRET=... \
EGMA_SIMULATOR_SIP_TRUNK_ADDRESS=your-trunk.pstn.twilio.com \
EGMA_SIMULATOR_SIP_TRUNK_NUMBER=+1... \
EGMA_SIMULATOR_SIP_TRUNK_USERNAME=... \
EGMA_SIMULATOR_SIP_TRUNK_PASSWORD=... \
EGMA_SIMULATOR_TTS_PROVIDER=elevenlabs EGMA_SIMULATOR_ELEVENLABS_API_KEY=... \
EGMA_SIMULATOR_STT_PROVIDER=deepgram EGMA_SIMULATOR_DEEPGRAM_API_KEY=... \
EGMA_SIMULATOR_CONTROL_PLANE_URL=http://127.0.0.1:8085 \
uv run egma-simulator
```

A connection's config carries the number and nothing secret: the trunk
belongs to the deployment, which is why it arrives here and never in a
spec. Set none of these and nothing changes — the simulator conducts chat
and loopback simulations exactly as before, and refuses a spec that names
a phone number with a sentence naming the variable to set.

## Configuration

Everything arrives as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EGMA_SIMULATOR_CONTROL_PLANE_URL` | (required) | Where to claim, heartbeat, and report. |
| `EGMA_SIMULATOR_SERVICE_TOKEN` | (none) | Sent as `Authorization: Bearer` on every outbound call. The workbench asks for none. |
| `EGMA_SIMULATOR_CAPACITY` | `4` | Most simulations conducted at once. |
| `EGMA_SIMULATOR_CLAIMANT` | `egma-simulator-<host>-<pid>` | The name stamped on claims. |
| `EGMA_SIMULATOR_HEARTBEAT_SECONDS` | `5` | Beat interval per running simulation. |
| `EGMA_SIMULATOR_CLAIM_WAIT_SECONDS` | `30` | How long one claim request may hang. |
| `EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS` | `120` | How long one report is resent before the log on disk becomes its only record. |
| `EGMA_SIMULATOR_MODEL_PROVIDER` | `scripted` | Where the persona's words come from: `scripted` or `openai`. |
| `EGMA_SIMULATOR_MODEL_BASE_URL` | `https://api.openai.com/v1` | The provider, for `openai` — any OpenAI-compatible endpoint. |
| `EGMA_SIMULATOR_MODEL_NAME` | (required for `openai`) | Which model to ask for. |
| `EGMA_SIMULATOR_MODEL_API_KEY` | (required for `openai`) | The provider key. Never logged. |
| `EGMA_SIMULATOR_STT_PROVIDER` | `scripted` | What the persona hears with, in a voice simulation: `scripted` or `deepgram`. |
| `EGMA_SIMULATOR_DEEPGRAM_API_KEY` | (required for `deepgram`) | The provider key. Never logged. |
| `EGMA_SIMULATOR_TTS_PROVIDER` | `scripted` | What the persona speaks with: `scripted` or `elevenlabs`. |
| `EGMA_SIMULATOR_ELEVENLABS_API_KEY` | (required for `elevenlabs`) | The provider key. Never logged. |
| `EGMA_SIMULATOR_MEDIA_BACKEND` | `livekit` | Which bridge places a phone call: `livekit`, or `scripted` for the local stand-in that places none. A connection may name its own. |
| `EGMA_SIMULATOR_LIVEKIT_URL` | (required to dial) | The LiveKit server — self-hosted or Cloud, only the URL differs. |
| `EGMA_SIMULATOR_LIVEKIT_API_KEY` | (required to dial) | The LiveKit API key. |
| `EGMA_SIMULATOR_LIVEKIT_API_SECRET` | (required to dial) | The LiveKit API secret. Never logged. |
| `EGMA_SIMULATOR_SIP_TRUNK_ID` | (one of the two trunk forms) | A SIP trunk already stored in LiveKit, by id. |
| `EGMA_SIMULATOR_SIP_TRUNK_ADDRESS` | (the other trunk form) | The carrier's termination hostname, for a trunk given inline. |
| `EGMA_SIMULATOR_SIP_TRUNK_NUMBER` | (none) | The number calls appear to come from. |
| `EGMA_SIMULATOR_SIP_TRUNK_USERNAME` | (none) | Credential auth for the inline trunk. |
| `EGMA_SIMULATOR_SIP_TRUNK_PASSWORD` | (none) | The trunk password. Never logged. |
| `EGMA_SIMULATOR_WAL_DIR` | `.egma-simulator/wal` | Where report documents land before sending. |
| `EGMA_SIMULATOR_BLOB_DIR` | `.egma-simulator/blobs` | Where recordings land, for the filesystem-backed blob store. |
| `EGMA_SIMULATOR_LOG_LEVEL` | `INFO` | The usual levels: `CRITICAL`, `ERROR`, `WARNING`, `INFO`, `DEBUG`. |
| `EGMA_SIMULATION_CONTRACT_DIR` | auto-located | The contract package, when the repo layout isn't around it. |

One of these is required and the rest have working defaults, which is the
whole rule. Anything set to something unusable stops the process on its
first line in a sentence naming the variable — a capacity that is not a
number, a level nobody defined, a URL with no scheme, a directory that
cannot be written. The two directories are proved by writing to them at
startup, and made if they are not there, because a volume mounted wrongly
would otherwise stay quiet until it lost a recording. Blank counts as
unset everywhere, so a compose entry can carry `${VAR:-}` for every
optional one.

## In a container

`apps/simulator/Dockerfile` builds it, from the repository root like the
other two apps — the contract package is the one thing it needs from
outside this directory, and it is copied in and pointed at with
`EGMA_SIMULATION_CONTRACT_DIR`. The image declares no port, because
nothing ever dials in.

The repository's `docker-compose.yml` runs it as one more service beside
the API, with a named volume for the recordings and the write-ahead log,
and `docker-compose.workbench.yml` is the dev overlay that stands a
workbench up beside it and points the simulator there:

```bash
docker compose -f docker-compose.yml -f docker-compose.workbench.yml \
  up --build simulator workbench
```

That is the same story as the two terminals above, in containers, with
the fixtures already inside the image. The root README tells the rest.

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
or write-ahead log.

Voice is proved the same way, off the same records: a voice fixture yields
a transcript, an ending, a band that is the one measured rather than the
one configured, and a reference — which is then opened, and each channel
transcribed, to show one speaker to a channel. One scenario run over chat
and over voice produces one transcript, which is the diagnostic the
modality split exists for.

The whole suite runs on the scripted model client and the deterministic
speech legs — no model, no provider, no network, so nothing can flake.
`tests/test_contract_fixtures.py` validates the golden fixtures in
`packages/simulation-contract` from the Python side — the other half of
the drift guarantee the TypeScript suite holds.

The `retell` plug converses with `tests/retell_stub.py`: a real local HTTP
server shaped like Retell's chat API, so proving the plug speaks the
protocol needs no account, no key and no network — failure paths included,
where a refused key and an endpoint nobody answers each end the simulation
`failed` with an honest reason and no leaked secret.

The `phone` plug converses through the scripted media backend the same
way: a spec naming a number yields a transcript, an ending, per-turn
timings, a measured band and a recording, with no LiveKit and no trunk
anywhere. Its failure paths are the point of the plug, so each is proved
too — busy, no answer, declined, a carrier that failed, and a trunk that
cannot be used at all — each ending `failed` with a reason naming what
the carrier said, and none of them ever reading as the agent failing. A
whole deployment's worth of LiveKit and trunk credentials is planted as
sentinels for those runs, so the scan afterwards is a scan of a process
that really held them.

One real conversation with a real Retell chat agent is opt-in, and skips
when the environment is silent, so nothing in CI waits on an account:

```bash
TEST_RETELL_API_KEY=key_... \
TEST_RETELL_AGENT_ID=agent_... \
uv run --frozen pytest tests/test_live_retell.py -v
```

`TEST_RETELL_BASE_URL` points that test somewhere other than Retell.

Real speech is opt-in the same way, one test per provider so a failure
names the leg, plus one for the pair working together. Each skips on its
own credential, and CI runs none of them:

```bash
ELEVENLABS_API_KEY=... uv run --frozen pytest tests/test_live_elevenlabs.py -v
DEEPGRAM_API_KEY=...   uv run --frozen pytest tests/test_live_deepgram.py -v
DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... \
  uv run --frozen pytest tests/test_live_speech.py -v
```

The first hears the persona speak for real and reads the recording back:
one channel a synthesized voice, the other still the test codec. The
second hands a checked-in recording of one spoken sentence —
`fixtures/spoken-sentence/` — to a real transcriber and checks the words
that come back, so proving the ears needs no synthesis. The third
conducts a whole voice simulation through both, against the loopback's
echo mode, where what a real voice says is what real ears read. All three
also plant their keys and scan every byte the run emitted, the way the
offline sentinel tests do. `TEST_DEEPGRAM_API_KEY` and
`TEST_ELEVENLABS_API_KEY` are read first, for a machine that keeps its
test credentials apart from its working ones.

One real phone call is opt-in too, and it takes a whole live deployment —
a LiveKit, a trunk, a number, and real speech providers, because a call
spoken in the test tone would prove nothing about a phone line. It skips
visibly listing whatever is missing, so CI never waits on any of it:

```bash
TEST_LIVEKIT_URL=wss://... \
TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \
TEST_SIP_TRUNK_ID=ST_... \
TEST_PHONE_NUMBER=+1... \
TEST_DEEPGRAM_API_KEY=... TEST_ELEVENLABS_API_KEY=... \
  uv run --frozen pytest tests/test_live_phone.py -v
```

Every name falls back to the `EGMA_SIMULATOR_*` one a real deployment
already sets, and a trunk arrives either as `TEST_SIP_TRUNK_ID` or inline
as `TEST_SIP_TRUNK_ADDRESS` with `TEST_SIP_TRUNK_USERNAME` and
`TEST_SIP_TRUNK_PASSWORD`. What it asserts is structure and not content:
a live agent says different words every time, so it checks that a
conversation happened, that it ended honestly, that the band was
measured, that the recording resolves with both channels carrying sound,
and that no credential reached a single byte the simulator wrote.

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
                  plug author's whole brief; scripted.py chats,
                  loopback.py speaks, retell.py is the first real
                  platform, and phone.py dials a number.
  media/          The media-backend seam: how a phone call's audio
                  travels. Its __init__ docstring is the driver author's
                  whole brief; livekit.py places real calls over a SIP
                  trunk, scripted.py is the one CI converses through.
  pipeline.py     One pipeline per simulation, built from its spec: which
                  legs the modality selects, and what the audio measured.
  speech.py       The speech legs, and the deterministic pair CI speaks
                  and listens with — no corpus, no provider, no network.
  blob.py         Where a recording is written and what a report points at.
  walk.py         One simulation's exchange: the turn loop, limits, cancel
                  delivery, and how each walk names its ending.
  reporting.py    Event minting, the write-ahead log, ordered delivery.
  redaction.py    Credential values registered once, scrubbed everywhere.
  workbench/      The fake control plane: same contract, fixture-fed,
                  records everything.
```
