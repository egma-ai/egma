# The dumb agent

A deliberately boring LiveKit agent — a dental-office receptionist with no
tools and one-sentence answers — so a simulation has something real on the
other side of the room while the thing under test is egma.

It is a genuine worker on `livekit-agents` 1.6.7 (the pin `docs/livekit.md`
uses): Silero VAD, OpenAI speech-to-text, `gpt-4o-mini`, OpenAI
text-to-speech. One OpenAI key runs all three steps.

## Run it

Put your values in `~/.egma-livekit.env` (see `.env.example`), then:

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

## The suite that simulates against it

`apps/simulator/tests/test_live_livekit_room.py` is the opt-in test that
conducts a whole simulation against this worker in a real room. It skips —
visibly, naming what is missing — until the environment carries all five of:

| Variable | Falls back to | What it is |
| --- | --- | --- |
| `TEST_LIVEKIT_URL` | `LIVEKIT_URL` | your LiveKit, Cloud or self-hosted |
| `TEST_LIVEKIT_API_KEY` | `LIVEKIT_API_KEY` | the key that opens the room |
| `TEST_LIVEKIT_API_SECRET` | `LIVEKIT_API_SECRET` | its other half |
| `TEST_DEEPGRAM_API_KEY` | `DEEPGRAM_API_KEY` | the persona's ears |
| `TEST_ELEVENLABS_API_KEY` | `ELEVENLABS_API_KEY` | the persona's voice |

`TEST_LIVEKIT_AGENT_NAME` falls back to `EGMA_DUMB_AGENT_NAME` — the same
variable this worker registers under — so one value moves both halves and
the two cannot disagree about which dispatch style is being exercised.

The last two are egma's, not this agent's: the persona is a synthetic
caller and needs its own speech, billed to you by those providers. The
OpenAI key is this agent's alone — sourcing one file puts it in both
processes, but egma reads no such variable and the persona never speaks
through it.

With the worker running, from the repository root:

```bash
set -a; source ~/.egma-livekit.env; set +a
cd apps/simulator && uv run pytest tests/test_live_livekit_room.py -v
```

## Sanity check without a server

```bash
uv run agent.py console
```

talks to the agent through this machine's own microphone and speaker —
no LiveKit server, no room. Useful only to prove the OpenAI key works.
