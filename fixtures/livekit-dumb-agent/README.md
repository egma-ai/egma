# The dumb agent

A deliberately boring LiveKit agent — a dental-office receptionist with
two tools and one-sentence answers — so a simulation has something real on
the other side of the room while the thing under test is Egma.

It is a genuine worker on `livekit-agents` 1.6.7: Silero VAD, OpenAI
speech-to-text, `gpt-4o-mini`, OpenAI
text-to-speech. One OpenAI key runs all three steps.

## One command: watch a mock tool answer

With your values in `~/.egma-livekit.env` (see `.env.example`), from the
repository root:

```bash
./fixtures/livekit-dumb-agent/calendar-is-full.sh
```

It starts this agent as a real worker, conducts one real simulation
against it in a real room with `check_availability` answered by a mock
tool that says the calendar is full, and hands back the transcript and the
record: which mock tool answered, with what, and how long it took. Then it
stops the worker.

That is the whole promise, watched working: the agent hears "there is
nothing free on Tuesday" from Egma rather than from a calendar, and offers
the caller another day.

If your LiveKit project and your speech providers live in different
environment files, name them all — colon separated, read left to right:

```bash
EGMA_LIVEKIT_ENV=~/.egma-livekit.env:~/.egma-voice.env \
  ./fixtures/livekit-dumb-agent/calendar-is-full.sh
```

## The two tools

| Tool | What it does | In the live test |
| --- | --- | --- |
| `check_availability(day)` | The booking-shaped one. Answers out of two times written into `agent.py`; there is no calendar behind it. | Answered by a **mock tool** — the calendar-is-full override, after a declared delay |
| `opening_hours()` | Reads out fixed opening hours. | **Not** mocked: it runs its own implementation, and the record names it uncovered |

Two rather than one, on purpose. A coverage stamp exists to say *this
simulation was not fully isolated, and here is what was left out* — and
with every tool covered it has nothing to say. The second tool is what
gives the record both halves.

Neither tool reads a clock, a network or a disk, so this worker can be
left running against a real project without booking anything, and an
unmocked run of it answers the same way every time.

## The one line that lets Egma answer

```python
await mockable(agent, ctx, session)
```

It sits in `entrypoint`, after the agent and the session exist and before
`session.start`. In a room Egma named for a simulation — every one of them
begins `egma-sim-` — it reports both tools by name and stands Egma in
front of whichever ones the simulation has answers for. That holds on both
dispatch styles, including the unnamed one where this worker is in the
room before Egma is. **In every other room it does nothing at all** — that
is the SDK's whole safety story, and `tests/test_outside_egma.py` holds
this agent to it rather than taking the SDK's word for it.

The `egma` dependency here is the copy in `sdks/python`, not the published
package, so this fixture always exercises the seam as it stands on this
branch.

## Run it by hand

```bash
cd fixtures/livekit-dumb-agent
set -a; source ~/.egma-livekit.env; set +a
uv run agent.py dev
```

`dev` registers the worker with your LiveKit server and waits for rooms.
Leave it running; Egma's simulations dispatch it per room.

## The six lines that make a chat simulation a chat simulation

```python
context = json.loads(ctx.job.metadata or "{}")
chat = context.get("modality") == "chat"
options = room_io.RoomOptions(
    audio_input=False,
    audio_output=False,
    text_output=room_io.TextOutputOptions(sync_transcription=False),
) if chat else room_io.RoomOptions()
```

They sit in `entrypoint`, beside the `mockable` line, and the options go
to `session.start(..., room_options=options)`. Egma sends the modality it
is conducting in the job's own metadata; these lines read it and answer in
kind. In a chat simulation the session takes no audio in, sends no audio
out, and stops tying its transcription to speech it is not producing.

That is the whole customer-side integration — no Egma package, and the
same shape in Node through its own input and output options.

Without them the agent still answers a chat simulation, because a LiveKit
session already listens for text. It answers it **aloud**: every reply is
synthesised, published and transcribed at the speed of the mouth producing
it, and the customer pays for speech nobody hears. Egma sees the published
audio track on the wire and stops the simulation at the agent's first
output rather than grading it.

**A production room carries no Egma metadata**, so `chat` is false there
and the options are the stock ones. The voice path is untouched by
construction rather than by care, which is the property
`tests/test_outside_egma.py` holds this file to.

## Naming the worker

`EGMA_DUMB_AGENT_NAME` is the name this worker registers under, and it is
required. Egma dispatches by name, always, because dispatch metadata is
the only channel carrying the modality and the address of Egma's mock-tool
seam — and LiveKit's automatic dispatch, which is what a worker registered
without a name gets, carries no dispatch metadata at all.

Naming a worker that was previously unnamed turns automatic dispatch off
for it: it then joins only the rooms whose dispatch asks for it.

## Send production telemetry to Egma

The fixture uses the same public function as a customer agent:

```python
monitor_livekit(ctx)
```

Set the Egma API origin and an existing project API key where the worker
runs. When both are blank, this multipurpose fixture leaves monitoring off so
its simulation smoke test needs no Monitoring setup. A partial setup stops
with a direct error.

```bash
export EGMA_URL=http://localhost:3100
export EGMA_API_KEY=egma_sk_...
```

`EGMA_URL` is the API address and carries no `/v1/traces` on the end. On
hosted Egma it is `https://api.egma.ai`. The key must name a **project**:
Egma rejects an organization-wide key before it decodes or stores the export.

The same setup works when this worker is customer-hosted or hosted in LiveKit
Cloud. The helper preserves LiveKit Cloud observability, batches export to
Egma, and flushes the last batch when the job stops. It skips Egma simulation
jobs, because those already have a simulation trace and must not appear a
second time in Monitoring.

## The suites that simulate against it

Three opt-in tests in `apps/simulator/tests` conduct whole simulations
against this worker in a real room:

- `test_live_livekit_room.py` — the spoken exchange itself: real speech,
  the band measured, the recording resolved.
- `test_live_mock_tools.py` — the calendar-is-full run, which the one
  command above drives.
- `test_live_livekit_chat.py` — the typed exchange: the six lines above
  really read, the turns text-paced, and no audio on the record at all.

All three skip — visibly, naming what is missing — until the environment
carries what each one needs:

| Variable | Falls back to | What it is | Needed by |
| --- | --- | --- | --- |
| `TEST_LIVEKIT_URL` | `LIVEKIT_URL` | your LiveKit, Cloud or self-hosted | all three |
| `TEST_LIVEKIT_API_KEY` | `LIVEKIT_API_KEY` | the key that opens the room | all three |
| `TEST_LIVEKIT_API_SECRET` | `LIVEKIT_API_SECRET` | its other half | all three |
| `TEST_LIVEKIT_AGENT_NAME` | `EGMA_DUMB_AGENT_NAME` | the name this worker registers under | all three |
| `TEST_MODEL_API_KEY` | `OPENAI_API_KEY` | the persona's brain | all three |
| `TEST_DEEPGRAM_API_KEY` | `DEEPGRAM_API_KEY` | the persona's ears | the two spoken ones |
| `TEST_CARTESIA_API_KEY` | `CARTESIA_API_KEY` | the persona's voice | the two spoken ones |

The typed suite needs neither speech key, and that is the product claim
written as an environment: a chat simulation invokes no speech-to-text and
no text-to-speech, so there is nothing to bill and nothing to configure.

`TEST_LIVEKIT_AGENT_NAME` is required rather than optional, because Egma
dispatches by name always. It falls back to `EGMA_DUMB_AGENT_NAME` — the
same variable this worker registers under — so one value moves both halves
and the two cannot disagree about which worker a dispatch asks for.

The persona's models are Egma's, not this agent's: it is a synthetic person
and needs its own brain, and for a spoken run its own speech, billed to you
by those providers. The OpenAI key is read by both, and by two different
processes for two different jobs.

With the worker running, from the repository root:

```bash
set -a; source ~/.egma-livekit.env; set +a
cd apps/simulator && uv run pytest tests/test_live_mock_tools.py -v -s
```

## This agent's own tests

Hermetic — no room, no server, no key — and run by `pnpm test` with
everything else:

```bash
cd fixtures/livekit-dumb-agent
uv run ruff check . && uv run pytest
```

What they hold this file to: both tools attached before `mockable` runs,
the integration line in the right place, and the whole thing untouched in
a room with no Egma in it.

## Sanity check without a server

```bash
uv run agent.py console
```

talks to the agent through this machine's own microphone and speaker —
no LiveKit server, no room. Useful only to prove the OpenAI key works.
