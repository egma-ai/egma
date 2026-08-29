# The simulator

The service that conducts simulations. It claims simulation specs from the
control plane over outbound HTTP, conducts each one as a real conversation
— the persona on one side, the agent under test on the other — and says
what happened as it happens, along two lines: the lifecycle — status
transitions and the terminal facts — as report events, and the
conversation itself — every turn, tool call and measurement — as
OpenTelemetry spans. It never touches the database and never imports
monorepo code: the versioned JSON contract in
`packages/simulation-contract` is its entire connection to the rest of
Egma, which is also what lets this one app be Python inside a TypeScript
monorepo.

Five seams shape the inside, and each exists to be swapped without
touching the others:

- **The persona brain** (`persona.py`) — one component for every modality,
  forever. It composes the spec's authored persona — the name they give the
  agent, how they behave, the language they speak — and the scenario
  instructions into a system prompt, takes the `human` side of the transcript
  turn by turn, and decides when the exchange is concluded. The name is stated
  rather than left to the model, so the same test hears the same person on
  every run.
- **The model client** (`model.py`) — where the persona's words come from.
  `scripted` walks the scenario deterministically and is what CI and the
  local story run on; `openai` speaks the OpenAI chat-completions shape to
  any provider, selected purely by configuration.
- **The connection plugs** (`plugs/`) — one component per connection type
  that alone knows how to reach and exchange turns with the target.
  Everything else is plug-blind. Two local stand-ins ship as the first
  plugs — the scripted counterpart, whose agent answers from a script over
  chat, and the loopback counterpart, which answers the same script in
  audio — and they are why the whole loop runs with no account and no
  network. `retell` is the first real one: it speaks Retell's chat API,
  driven entirely by the spec's connection block, and adding it changed
  nothing outside `plugs/`. `phone` dials a number — provider-blind by
  construction, because the telephone network neither knows nor cares
  what answers, so a Retell agent, a Vapi agent and a person behind a
  number are all one plug. `livekit` reaches an agent where it lives: a
  room made in the customer's own LiveKit project, joined outbound, with
  the agent's worker dispatched into it. `retell_web_call` reaches a
  Retell *voice* agent the same way its browser callers do: egma creates
  the call itself — against a named version of the agent, with this
  simulation's variables attached — and Retell answers with a way into a
  LiveKit room, so the plug creates and the room media joins.
  `retell_text_mode` reaches the same Retell *voice* agent in **text**:
  it speaks Retell's agent-playground completion API, which keeps nothing
  between requests, so every request carries the whole history, the
  version by name, this simulation's variables, egma's own answers as
  native mocks, and where the engine had got to. It is the one plug that
  puts egma in the agent's tool path without standing between the two —
  the platform serves egma's answers itself — and the one lane with no
  provider reference to offer, because text mode stores nothing. To
  write the next, read the `plugs/__init__.py` docstring; it is the
  entire brief.
- **The media backends** (`media/`) — how a voice exchange's audio
  travels. One driver per way in, behind a four-method seam: create a
  Pipecat transport, dial, wait until somebody answers, tear it down.
  `livekit.py` places real phone calls over the SIP trunk carried by the
  claimed work order; `livekit_room.py` holds an exchange in a room
  joined three ways — one egma makes and dispatches into, one a
  customer's own endpoint mints the way into, and one a platform opened
  for a call of its own — where "dial" means asking for a worker rather
  than placing a call, and asks for nobody at all on the two shapes egma
  holds no key pair for; `scripted.py` is the local stand-in
  that answers a call nobody placed, and is what CI runs on. The two that
  join a room share `room.py`, which is the joining itself. Nothing above
  the seam — the plug's lifecycle, the pipeline, the recording, the
  report — learns which one ran, so another way in is one new module. To
  write one, read the `media/__init__.py` docstring; it is the entire
  brief.
- **The speech legs** (`speech.py`) — a voice simulation is a chat one
  with three more legs: the persona's words spoken into audio, the
  agent's audio read back into words, and a detector that hears *whether*
  the agent is speaking at all. Which one fills each is configuration
  read from the pinned persona version at assembly and nowhere else. Cartesia
  or OpenAI speaks; Deepgram or OpenAI listens; Silero hears activity. The
  deterministic model and speech implementations exist only as explicit test
  injections: no account, no network, and the same words out that went in.
  Nothing above the assembly learns which set it got, which is what keeps a
  future speech-to-speech persona a different leg-set rather than a rewrite.

One pipeline is assembled per simulation from its own spec and torn down
after (`pipeline.py`). Modality selects the legs. Connection type selects the
plug, and access variant supplies that plug's configuration and authority. A
chat simulation is the plug and the brain, looped
a turn at a time. A voice simulation on a full-duplex transport is the
same brain with the speech legs around it, conducted by a real Pipecat
pipeline (`conductor.py`): both directions of the transport are open at once,
the detector and the turn model decide where turns fall, and nothing
announces a turn because nothing announces one on a real call. A spec
naming a connection type the simulator holds no plug for is refused out
loud at claim time and reported not at all: the row stays the control
plane's to sweep.

## What a voice simulation records

The same transcript, ending and measurements a chat simulation records,
plus what only audio can owe:

- **A dual-channel recording**, the persona on channel 0 and the agent on
  channel 1, so either side can be heard alone when a transcript looks
  wrong. It is written through the blob seam (`blob.py`) — one interface
  with two implementations, an object store for a deployment that names
  an endpoint and a directory for one that does not, so a first voice
  simulation needs no container running — and the report carries only the
  reference, never the bytes and never a URL.
- **Per-turn measurements**, all read from the audio itself rather than
  from a clock: `time_to_first_word` (how long the agent was quiet before
  speaking), `agent_speech_duration` and `persona_speech_duration`. Each
  is a span, like every other measurement.

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
same bytes, so the receiving side can dedup on event ids. A report carries
the lifecycle and nothing else — the conversation has its own record,
below — so the one summary fact it keeps about what was said is how many
turns there were. Credentials from specs exist only in memory, are handed
only to the plug, and are scrubbed from every log line — the report schema
has no place to put them even by accident.

## The conversation, as spans

The OpenTelemetry SDK (`spans.py`) authors every turn, tool call, and
measurement and streams them to the control plane's OTLP ingest while
the simulation runs — the same door a customer's own agent exports to, so
a simulation is readable the way a production trace is readable, live and
partial included. The vocabulary — the scope, the span names, the
attribute keys, how a batch names its simulation, and how a trace id is
derived from a simulation id — is
[`packages/simulation-contract/span-vocabulary.md`](../../packages/simulation-contract/span-vocabulary.md),
pinned as golden fixtures beside it.

Three things about it are worth knowing before reading the code:

- **Delivery is the reporter's.** The SDK's official OTLP encoder feeds span batches
  through the same write-ahead log and the same single ordered sender the
  lifecycle documents ride. A resend is byte-identical, which lets ClickHouse
  suppress a recent exact block repeat. Later, regrouped, reordered, or changed
  blocks can append. The reporter creates the terminal report only after the
  ingest accepts every earlier span, so the control plane can read the trace
  when it records the terminal state.
- **A timing span's own duration is the measurement.** A span named for a
  measure opens one measurement before the moment it was taken, so the
  number is the interval in nanoseconds and there is no second field to
  disagree with it.
- **Turn spans may overlap.** A chat message is one instant; a voice turn
  is as long as the audio, ear to ear, and two turns are free to cross in
  time. On voice both of a turn's ends are positions on the audio itself —
  counted in samples, never stamped off a clock — so whether two turns
  crossed is a fact about what was said rather than about when code ran.

Pipecat's native service tracing is on and keeps its own scope and fields.
Pipecat interaction-cycle turn tracking stays off. Only Egma's
`human_turn` and `agent_turn` spans make transcript lines. Egma authors those
spans where it observes the exchange, so they can represent overlap.

The simulator reaches the ingest at the control-plane URL it already has.
There is no second address to configure.

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
each heartbeat, each reported event, each span as it arrives at its small
OTLP sink — which is a simulation going queued → claimed → running →
completed, live, with the conversation streaming past in between. The checked-in
fixtures use sentinel direct provider keys, so a bare production simulator
reports the provider refusal honestly. The black-box tests inject deterministic
model and speech implementations explicitly; production has no scripted
fallback. The `retell` fixture really does
dial Retell and fails at the door, because the key in a fixture is a
placeholder, and so does the `livekit` one, whose server is an example
hostname; the `phone` fixture is refused with a clear log
line naming `EGMA_SIMULATOR_MEDIA_BACKEND`, because a local run
configures no media backend to place a call through.
`GET /workbench/records` returns the same as JSON;
`POST /workbench/simulations/<id>/cancel` flags a cancel directive for the
next heartbeat; `POST /workbench/specs` queues another spec while
everything runs.

Model and speech choices are not container settings. Every contract-v5 work
order carries one complete `models` block from the pinned persona version. The
API resolves each catalog selection to an explicit adapter before it creates
that work order. Chat requires the direct LLM key. Voice also requires the
direct STT and TTS keys. The TTS selection owns `voice_id` and `speed`; the
`persona` block carries who is calling — `name`, `personality`, `language`, all
three required — and says nothing about how they are rendered.

The model catalog owns which provider/model pairs the product accepts. The
simulation contract checks only the work-order shape. The simulator dispatches
the named adapter and rejects an adapter it does not ship; it does not keep a
second model allowlist. There is no container or persona fallback. The scripted
model and speech pair exist only as explicit test injections.

Voice activity detection is still deployment configuration. Real speech uses
`EGMA_SIMULATOR_VAD_PROVIDER=silero`; it needs no key and downloads nothing.

To dial a real phone number, point the simulator at a LiveKit server. The same
three LiveKit variables serve a self-hosted server and LiveKit Cloud. They
configure only the media bridge. They do not select a carrier route.

For Twilio, an administrator creates one shared trunk, source number, and
attached credential list. Each developer and production gets one SIP
username/password in that list. The operator puts that deployment's trunk
address, source number, and SIP pair in the platform workspace's `.env`, then
runs `egma self-host up`. The four values are ordinary deployment credentials
and are not stored in Postgres. The pair comes from the trunk's SIP credential
list, never from the Twilio Account SID and Auth Token. Egma never changes the
Twilio account.
Every simulator receives the carrier route only on a phone work order it claims.
There is no simulator trunk environment fallback and no stored LiveKit trunk
ID. See the root README.

Real speech providers belong with all this: a call spoken in the test
tone reaches a real agent as noise.

```bash
EGMA_SIMULATOR_MEDIA_BACKEND=livekit \
EGMA_SIMULATOR_LIVEKIT_URL=wss://... \
EGMA_SIMULATOR_LIVEKIT_API_KEY=... \
EGMA_SIMULATOR_LIVEKIT_API_SECRET=... \
EGMA_SIMULATOR_CONTROL_PLANE_URL=http://127.0.0.1:8085 \
uv run egma-simulator
```

A connection's config carries the destination number and nothing secret. The
media backend belongs only to the deployment. A phone work order carries the
platform's complete SIP route as one unit. A missing route fails that phone
simulation; it does not make the simulator search another source. Chat and
loopback simulations do not need a carrier route.

Where the LiveKit server itself comes from is the root README's story:
it, its SIP gateway and their Redis are part of the default deployment,
told there with the honest account of what that gateway needs from your
network. The workbench is not a real-call launcher. Its fixtures use sentinel
provider keys and only prove the simulator contract. Create a run through the
platform to prove a real phone simulation through the same claim path that
production uses.

Pipecat and the transport choose the media rate. Egma does not force a
phone processing rate or store a separate sample-rate field. The
recording's WAV header tells a player how to play the file; it does not
describe the connection's codec or acoustic quality.

## Configuration

Everything arrives as environment variables.

Model, speech, voice, and their direct keys are absent from this table because
the work order is their only source. The environment contains deployment
transport and process settings only.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EGMA_SIMULATOR_CONTROL_PLANE_URL` | (required) | Where to claim, heartbeat, and report. |
| `EGMA_SIMULATOR_SERVICE_TOKEN` | (none) | Sent as `Authorization: Bearer` on every outbound call. The real control plane requires it and checks it against its own `EGMA_SIMULATOR_SERVICE_TOKEN`. `egma self-host up` generates one private workspace value and gives the same value to both containers; an advanced deployment must supply the matching value to both processes. The claim answers carry live provider credentials. The workbench asks for none. |
| `EGMA_SIMULATOR_CAPACITY` | `2` | Most simulations conducted at once. Compose passes an unset value through, so this process owns the default in every deployment. A voice simulation costs a channel on the deployment's carrier trunk, so raise it only as far as the trunk allows. |
| `EGMA_SIMULATOR_CLAIMANT` | `egma-simulator-<host>-<pid>` | The name stamped on claims. |
| `EGMA_SIMULATOR_HEARTBEAT_SECONDS` | `5` | Beat interval per running simulation. |
| `EGMA_SIMULATOR_CLAIM_WAIT_SECONDS` | `30` | How long one claim request is willing to hang, sent as the claim's `wait_seconds` so the control plane holds no longer than the client will wait. The control plane caps its own hold below this default. |
| `EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS` | `120` | How long one report is resent before the log on disk becomes its only record. |
| `EGMA_SIMULATOR_VAD_PROVIDER` | `scripted` | What hears the agent start and stop speaking: `scripted`, which reads the test tone exactly, or `silero`. Needs no key either way — Silero ships inside the pinned pipecat wheel and downloads nothing. |
| `EGMA_SIMULATOR_MEDIA_BACKEND` | (none) | Which media backend places a phone call: `livekit`, or `scripted` for the local stand-in that places none. Unset, the simulator places no calls and says so when a simulation names a number. |
| `EGMA_SIMULATOR_LIVEKIT_URL` | (required for `livekit`) | The LiveKit server — self-hosted or Cloud, only the URL differs. |
| `EGMA_SIMULATOR_LIVEKIT_API_KEY` | (required for `livekit`) | The LiveKit API key. |
| `EGMA_SIMULATOR_LIVEKIT_API_SECRET` | (required for `livekit`) | The LiveKit API secret. Never logged. |
| `EGMA_SIMULATOR_WAL_DIR` | `.egma-simulator/wal` | Where report documents land before sending. |
| `EGMA_SIMULATOR_S3_ENDPOINT` | (none) | Where the object store recordings go to answers, on the deployment's own network. Naming it is the whole of what selects object storage, and what makes the two credentials below required; naming none keeps the filesystem store, so a checkout needs no container. |
| `EGMA_SIMULATOR_S3_BUCKET` | `egma-recordings` | The bucket recordings land in. The deployment creates it on first start. |
| `EGMA_SIMULATOR_S3_REGION` | `us-east-1` | What requests are signed for. MinIO ignores it; a bucket at a real provider does not. |
| `EGMA_SIMULATOR_S3_ACCESS_KEY_ID` | (required with an endpoint) | The write credential's key id. Never logged. |
| `EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY` | (required with an endpoint) | The write credential's secret. Never logged. |
| `EGMA_SIMULATOR_BLOB_DIR` | `.egma-simulator/blobs` | Where recordings land when no endpoint above names an object store. Unread, and not even created, when one does. |
| `EGMA_SIMULATOR_LOG_LEVEL` | `INFO` | The usual levels: `CRITICAL`, `ERROR`, `WARNING`, `INFO`, `DEBUG`. |
| `EGMA_SIMULATION_CONTRACT_DIR` | auto-located | The contract package, when the repo layout isn't around it. |

One of these is required and the rest have working defaults, which is the
whole rule. Anything set to something unusable stops the process on its
first line in a sentence naming the variable — a capacity that is not a
number, a level nobody defined, a URL with no scheme, a bucket no store
would take, a credential missing beside the endpoint that needs it, a
directory that cannot be written. Each directory it will really use is
proved by writing to it at startup, and made if it is not there, because
a volume mounted wrongly would otherwise stay quiet until it lost a
report; a simulator sending its recordings to object storage has no
recordings directory and is not asked for one. Blank counts as unset
everywhere, so a compose entry can carry `${VAR:-}` for every optional
one.

What is *not* checked at startup is whether the object store answers.
That is a question only the store can settle, and a simulator that
refused to start until it could ask would be a simulator that dies
because its store came up five seconds behind it. The deployment orders
that instead: the bucket job runs to completion before the simulator
starts.

## In a container

`apps/simulator/Dockerfile` builds it, from the repository root like the
other two apps — the contract package is the one thing it needs from
outside this directory, and it is copied in and pointed at with
`EGMA_SIMULATION_CONTRACT_DIR`. The image declares no port, because
nothing ever dials in.

The repository's `docker-compose.yml` runs it as one more service beside
the API, with a named volume for the write-ahead log and an object store
for the recordings, and `docker-compose.workbench.yml` is the dev overlay
that stands a workbench up beside it and points the simulator there:

```bash
docker compose -f docker-compose.yml -f docker-compose.workbench.yml \
  up --build simulator workbench
```

That is the same story as the two terminals above, in containers, with
the fixtures already inside the image.

The LiveKit server, its SIP gateway and their Redis are not an overlay:
they are in the default compose file, so `docker compose up` starts them
with everything else. The simulator publishes nothing whichever overlays
are on — the gateway is the one container in Egma a carrier talks to, and
what that costs a self-hoster is the root README's story to tell.

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
a transcript, an ending and a recording reference. Its trace carries one
recording-origin span on the same clock as the spoken turns. The recording is
then opened and each channel is transcribed to show one speaker to a channel.
One scenario run over chat and over voice produces one transcript, which
is the diagnostic the modality split exists for.

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

The `retell_text_mode` plug converses with `tests/text_mode_stub.py`: a
real local HTTP server shaped like the completion API, which matches and
serves the mocks each request carries the way the platform does — so a
plug that forgot to send them would see real answers come back, and the
plug refuses to stamp a call `mocked` until it has checked that the tool
was really given Egma's own answer.

Every wire field name that Retell's documentation was not in reach for is
marked a guess in the plug's docstring. Correcting one after a live run
means editing **three** places, listed here so none is missed: the plug,
the stub, and `tests/test_plug_retell_text_mode.py`, which names several
of the fields in its assertions. The stub deliberately does not import
the plug's constants — a counterpart that took its wire from the thing it
is testing would agree with a mistake instead of catching it.

The `phone` plug converses through the scripted media backend the same way: a
spec naming a number yields a transcript, an ending, per-turn timings and a
recording without contacting LiveKit or a real carrier. Its failure paths are
the point of the plug, so each is proved too — busy, no answer, declined, a
carrier that failed, and a trunk that cannot be used at all — each ending
`failed` with a reason naming what the carrier said, and none of them ever
reading as the agent failing. The deployment's LiveKit bridge values and the
work order's carrier fields are planted as sentinels, so the scan afterwards
covers both credential paths the process really held.

The `livekit` plug converses with `tests/room_stub.py`, which stands in
for the three places its driver reaches a LiveKit — the requests it makes
of the project, joining the room, and deleting it — and leaves every
other line of the driver real. So a whole simulation in a room runs with
no server, no project and no worker, and what the suite proves about a
refusal or an ending is proved about the code a customer's server will
run: the two dispatch paths and the metadata each carries, a worker that
never comes and one that joins and publishes nothing, an agent that
leaves mid-exchange, and the room deleted however it ended. The
customer's api secret is a sentinel there too.

One real chat simulation of a real Retell **voice** agent in text mode is
opt-in, and skips when the environment is silent, so nothing in CI waits on
an account:

```bash
TEST_RETELL_API_KEY=key_... \
TEST_RETELL_AGENT_ID=agent_... \
TEST_MODEL_API_KEY=sk-... \
uv run --frozen pytest tests/test_live_text_mode.py -v -s
```

The agent must be a voice agent on a conversation flow or a Retell LLM: a
custom-LLM agent holds its words and tools on the customer's own service,
where this lane reaches neither, and is refused. `TEST_MODEL_API_KEY` is the
persona's own brain, so the caller reasons for real rather than reading a
script. `TEST_RETELL_SCENARIO` tunes what the persona calls about, and
`TEST_RETELL_BASE_URL` points the test somewhere other than Retell.

Real speech is opt-in the same way. Each test skips without its credentials,
and CI runs none of them:

```bash
DEEPGRAM_API_KEY=...   uv run --frozen pytest tests/test_live_deepgram.py -v
DEEPGRAM_API_KEY=... CARTESIA_API_KEY=... \
  uv run --frozen pytest tests/test_live_speech.py -v
```

The first hands a checked-in recording of one spoken sentence —
`fixtures/spoken-sentence/` — to a real transcriber and checks the words
that come back, so proving the ears needs no synthesis. The second
conducts a whole voice simulation through Cartesia and Deepgram, against the loopback's
echo mode, where what a real voice says is what real ears read. All three
also plant their keys and scan every byte the run emitted, the way the
offline sentinel tests do. `TEST_DEEPGRAM_API_KEY` and
`TEST_CARTESIA_API_KEY` are read first, for a machine that keeps its test
credentials apart from its working ones.

Object storage is real in `tests/test_object_storage.py` and costs you
nothing to have: it starts a MinIO container of its own, on a port of its
own, and removes it afterwards. Where docker cannot start one it says so
and skips, never passing quietly. There is no fake, on purpose — a
stand-in would agree with whatever this code believed about signatures,
addressing and buckets, which is the whole set of things that go wrong
between a client and an object store. It holds two things: the seam's own
rules against the store a deployment really runs, and a whole voice
simulation whose recording is fetched out of the bucket and listened to,
one speaker to a channel. Every other suite here writes to a directory,
which is what makes the rest of this app testable with no container at
all.

Carrier provisioning is not this app's. A carrier administrator creates the
trunk and SIP credential. The platform's `.env` holds the four runtime values,
and `egma self-host up` gives them to the API as ordinary environment variables.
Egma never contacts Twilio. Its tests use a local server shaped like the Twilio
APIs as a tripwire and require zero requests.

`tests/test_deployment.py` compares the deployment story against the code that
reads it. Every operator-controlled simulator variable is documented; the
shipped Compose file fixes the media backend to LiveKit and VAD to Silero;
nothing documents a variable the code does not read; and the simulator
publishes no port. Plain `docker compose up` starts LiveKit, its SIP gateway and
their Redis as part of the default stack.

One real phone call is opt-in too, and it takes a whole live deployment —
a LiveKit, a trunk, a number, and real speech providers, because a call
spoken in the test tone would prove nothing about a phone line. It skips
visibly listing whatever is missing, so CI never waits on any of it:

```bash
TEST_LIVEKIT_URL=wss://... \
TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \
TEST_SIP_TRUNK_ADDRESS=your-trunk.pstn.twilio.com \
TEST_SIP_TRUNK_NUMBER=+1... \
TEST_SIP_TRUNK_USERNAME=... TEST_SIP_TRUNK_PASSWORD=... \
TEST_PHONE_NUMBER=+1... \
TEST_MODEL_API_KEY=... TEST_DEEPGRAM_API_KEY=... \
TEST_CARTESIA_API_KEY=... \
  uv run --frozen pytest tests/test_live_phone.py -v
```

The harness puts these test-only SIP values into that test work order's
`platform.carrier`. They are not production configuration or a fallback for a
claimed work order. What the test asserts is structure and not content: a live
agent says different words every time, so it checks that a conversation
happened, that it ended honestly, that the recording resolves with both
channels carrying sound, and that no credential reached a single byte the
simulator wrote.

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
                  platform, phone.py dials a number, livekit.py holds
                  an exchange in the agent's own room,
                  retell_web_call.py creates a Retell web call and
                  conducts it in the room that call opens, and
                  retell_text_mode.py conducts a Retell voice agent in
                  text, with no call and no audio anywhere.
  media/          The media-backend seam: how a voice exchange's Pipecat
                  transport is created. Its __init__ docstring is the
                  driver author's whole brief; livekit.py places real calls over a SIP
                  trunk, livekit_room.py joins a room three ways and
                  dispatches an agent into the one egma makes,
                  room.py is the joining the two of them share, and
                  scripted.py is the one CI converses through.
  pipeline.py     One pipeline per simulation, built from its spec: which
                  legs the modality selects, which of the two conductors
                  it gets, and what evidence it records.
  conductor.py    A voice simulation on a full-duplex transport, conducted
                  by a real Pipecat pipeline: the detector, the turn model,
                  the brain, the legs, and the audio timeline the record is
                  anchored to.
  speech.py       The speech legs, and the deterministic pair CI speaks
                  and listens with — no corpus, no provider, no network.
  recording.py    One simulation's dual-channel recording and the
                  recording reference a report carries.
  blob.py         Where a recording is written and what a report points
                  at: one key-confining seam, an object store and a
                  directory behind it.
  conversation.py One chat simulation's exchange: the turn loop, limits,
                  cancel delivery, and how each conversation names its ending.
  reporting.py    Event minting, the write-ahead log, ordered delivery.
  redaction.py    Credential values registered once, scrubbed everywhere.
  workbench/      The fake control plane: same contract, fixture-fed,
                  records everything.
```
