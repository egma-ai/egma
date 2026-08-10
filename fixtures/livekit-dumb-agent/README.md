# The dumb agent

A deliberately boring LiveKit agent — a dental-office receptionist with
two tools and one-sentence answers — so a simulation has something real on
the other side of the room while the thing under test is egma.

It is a genuine worker on `livekit-agents` 1.6.7 (the pin `docs/livekit.md`
uses): Silero VAD, OpenAI speech-to-text, `gpt-4o-mini`, OpenAI
text-to-speech. One OpenAI key runs all three steps.

## The founder's one command

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
nothing free on Tuesday" from egma rather than from a calendar, and offers
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

## The one line that lets egma answer

```python
await mockable(agent, ctx, session)
```

It sits in `entrypoint`, after the agent and the session exist and before
`session.start`. In a room egma dispatched, it reports both tools by name
and stands egma in front of whichever ones the simulation has answers for.
**In every other room it does nothing at all** — that is the SDK's whole
safety story, and `tests/test_outside_egma.py` holds this agent to it
rather than taking the SDK's word for it.

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
Leave it running; egma's simulations dispatch it per room.

## The two dispatch styles

- `EGMA_DUMB_AGENT_NAME` blank → the worker registers **unnamed**:
  automatic dispatch, it joins every new room in the project. The
  quickstart default, and egma's blank-`agentName` path.
- `EGMA_DUMB_AGENT_NAME=front-desk` → the worker registers **named**:
  it joins only rooms whose dispatch asks for `front-desk`. egma's
  named-`agentName` path.

## The suites that simulate against it

Two opt-in tests in `apps/simulator/tests` conduct whole simulations
against this worker in a real room:

- `test_live_livekit_room.py` — the conversation itself: a real spoken
  exchange, the band measured, the recording resolved.
- `test_live_mock_tools.py` — the calendar-is-full run, which the one
  command above drives.

Both skip — visibly, naming what is missing — until the environment
carries all six of:

| Variable | Falls back to | What it is |
| --- | --- | --- |
| `TEST_LIVEKIT_URL` | `LIVEKIT_URL` | your LiveKit, Cloud or self-hosted |
| `TEST_LIVEKIT_API_KEY` | `LIVEKIT_API_KEY` | the key that opens the room |
| `TEST_LIVEKIT_API_SECRET` | `LIVEKIT_API_SECRET` | its other half |
| `TEST_DEEPGRAM_API_KEY` | `DEEPGRAM_API_KEY` | the persona's ears |
| `TEST_ELEVENLABS_API_KEY` | `ELEVENLABS_API_KEY` | the persona's voice |
| `TEST_MODEL_API_KEY` | `OPENAI_API_KEY` | the persona's brain |

`TEST_LIVEKIT_AGENT_NAME` falls back to `EGMA_DUMB_AGENT_NAME` — the same
variable this worker registers under — so one value moves both halves and
the two cannot disagree about which dispatch style is being exercised.

The persona's three are egma's, not this agent's: it is a synthetic caller
and needs its own speech and its own brain, billed to you by those
providers. The OpenAI key is read by both, and by two different processes
for two different jobs.

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
a room with no egma in it.

## Sanity check without a server

```bash
uv run agent.py console
```

talks to the agent through this machine's own microphone and speaker —
no LiveKit server, no room. Useful only to prove the OpenAI key works.
