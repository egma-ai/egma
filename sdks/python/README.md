# Egma Python SDK

Test a LiveKit agent with mock tools and send its production spans to Egma.

The two functions are separate:

- `mockable(...)` lets Egma answer tools in an Egma simulation. It does
  nothing in production.
- `monitor_livekit(...)` sends production LiveKit spans to the
  Monitoring page. It does nothing in an Egma simulation.

Calling one function never enables or changes the other.

## Install

```bash
pip install egma
```

For a LiveKit agent on Python 3.11 or newer.

## Production monitoring

Open **Monitoring → Start monitoring** and choose **LiveKit**. That page
shows the same SDK, key, and helper steps below. It is instructions only: a
LiveKit agent pushes its own spans, so there is nothing to switch on in Egma.

Set the Egma API origin and an existing project API key in the agent's
environment:

```bash
export EGMA_URL=https://api.egma.ai
export EGMA_API_KEY=egma_sk_...
```

For self-hosted Egma, prefer the published API address, such as
`http://localhost:3100`. The web address also works because Egma forwards
`/v1/traces` to the API, but the API is one hop shorter. The agent process must
be able to make HTTP or HTTPS requests to the address you choose.

In a customer-hosted worker, set these values through your normal deployment
secret store. For LiveKit Cloud, place them in a gitignored secrets file and
apply it to the agent:

```bash
lk agent update-secrets --secrets-file=.env.monitoring
```

Use the same file with `lk agent create --secrets-file=.env.monitoring` for a
new deployment. LiveKit Cloud restarts the agent after a secret update.

Call `monitor_livekit` before `AgentSession.start`:

```python
from egma import monitor_livekit
from livekit import agents
from livekit.agents import Agent, AgentSession


async def entrypoint(ctx: agents.JobContext) -> None:
    monitor_livekit(ctx)
    await ctx.connect()

    agent = Agent(instructions=INSTRUCTIONS, tools=[check_calendar])
    session = AgentSession(stt=..., llm=..., tts=...)
    await session.start(agent=agent, room=ctx.room)
```

You can pass the same values directly when environment variables are not the
right configuration source:

```python
monitor_livekit(ctx, endpoint="https://api.egma.ai", api_key=project_key)
```

Use the same call for an agent hosted in your cloud and an agent hosted in
LiveKit Cloud. The helper adds Egma to a compatible OpenTelemetry provider; it
does not remove LiveKit Cloud observability or another existing span
processor. It sends spans in batches and flushes the final batch when the
LiveKit job stops.

If this job was dispatched by Egma for a simulation, the helper returns
without adding a production exporter. The simulation keeps its own trace and
does not appear a second time in Monitoring.

After deployment, open **Monitoring**. Nothing needs to be confirmed in Egma —
the deployed helper is what sends spans, and the first production conversation
appears in the list as soon as it arrives.

The caller's phone, SIP, or WebRTC entry path does not change this setup. The
SDK does not guess that path from a LiveKit trace.

### Setup status

The helper stops immediately with one direct error when required settings are
missing or malformed, or when tracer providers conflict. It does not include
the key in that error.

After deployment, Monitoring stays empty until the first trace reaches Egma,
then lists each production conversation as it arrives. This release uses one-way
OTLP export. Egma cannot see a DNS, firewall, or network failure inside the
worker. Check the worker's OpenTelemetry logs and confirm that it can reach
`EGMA_URL` when nothing appears.

## Simulation mock tools

A simulation that reaches your real tools has real side effects: it books
the appointment, sends the message, charges the card. And a real backend
only ever shows you the branch its data happens to be on — "the calendar
is full", "the lookup fails", "the booking API errors" are where voice
agents die in production, and none of them can be ordered up from a real
backend on demand.

A **mock tool** answers for one of your agent's tools during a
simulation. It is authored in your Egma project, matched strictly by tool
name, and its answer may be a value, an error, or either one after a
declared delay so a mocked backend takes as long as the real one. This
package is the piece that lives in your own agent's process and lets Egma
answer.

Tools no mock tool covers run their real implementations, untouched.
Egma's record names which of your tools were covered and which were not,
so you always know whether a simulation was fully isolated.

### Use

One call, after the agent is built and before the session starts:

```python
from egma import mockable
```

```python
async def entrypoint(ctx: agents.JobContext) -> None:
    agent = Agent(instructions=INSTRUCTIONS, tools=[check_calendar, book_appointment])
    session = AgentSession(stt=..., llm=..., tts=...)

    await mockable(agent, ctx, session)

    await session.start(agent=agent, room=ctx.room)
```

That is the whole simulation integration.

`mockable` uses LiveKit's `JobContext.connect()` before its in-room RPC
when an Egma simulation reaches it before the normal session connection.
It does not reconnect an already-connected room, and it does not connect
a production room.

In a simulation, `mockable` reports your agent's tools to Egma — names
and schemas, read off the agent object, so mock authoring starts from
your real tool names instead of your memory of them — and learns which of
them this simulation answers for. Calls to those tools go to Egma and
come back with the authored answer. Every one of them lands on the
simulation's record with its arguments, its answer, how long it took, and
which mock tool answered.

**In every other room it does nothing at all.** Egma names itself in the
job's dispatch metadata; a room with no Egma in it — which is every
production room — is a room where `mockable` returns having touched
nothing. Your tools are the same objects, called the same way, with no
wrapper between them and the model. Zero added latency, by construction
rather than by care. That property is a test in this package
(`tests/test_inert.py`), not a promise in this file.

### Where to call it

After the agent object exists and before `session.start`. The report of
your tools is the first thing said, so an Egma that is not in the room is
discovered before any tool call rather than half way through a test.

`mockable` covers the exact `Agent` class you hand it. If your app hands
off between several agent classes, call it once per class you want
covered.

### What a call to a mocked tool does

- Goes to Egma over the same LiveKit room. No new endpoint, no new
  credential, nothing new to expose. If needed, `mockable` connects that
  room through the job context before sending the first RPC.
- Comes back with the authored answer, or raises the authored error as
  the tool's own error, so your agent handles it exactly as it would
  handle a real backend failing.
- **Falls open** if Egma turns out not to be reachable: your real tool
  runs, and the agent behaves as it would with this package uninstalled.
- **Never waits forever.** Every branch ends in an answer, an error the
  model can hear, or your own tool running.

A tool you attach to the agent *after* calling `mockable` is still
intercepted on its first call — Egma's answers are held by name. Its
arguments may be incomplete on the record, and Egma marks that call so
you can see it.

### Logging

Everything this package says goes to the `egma` logger. It is worth
having on at `INFO` the first time you wire an agent up: the line after
the census names how many tools you have and how many Egma answers for.

## Before you install anything: the interim recipe

You can get isolation today with no Egma code at all, using LiveKit's own
`mock_tools` and a guard you write yourself:

```python
import json

from livekit.agents import mock_tools


def in_a_simulation(ctx: agents.JobContext) -> bool:
    try:
        return bool(json.loads(ctx.job.metadata or "{}").get("egmaIdentity"))
    except ValueError:
        return False


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    agent = Agent(instructions=INSTRUCTIONS, tools=[check_calendar])
    session = AgentSession(stt=..., llm=..., tts=...)

    if in_a_simulation(ctx):
        mock_tools(
            type(agent),
            {"check_calendar": lambda day: "No free slots on that day."},
            session=session,
        )

    await session.start(agent=agent, room=ctx.room)
```

This is production-safe by the same absence logic: no Egma in the room
means the guard is false and nothing is wrapped.

What it cannot do is the rest of the job. One canned world for every
test, so you cannot write "the calendar is full" as a *test* — you would
be editing your agent's source to change a test's data. Nothing about
those calls reaches Egma's record: no arguments, no answers, no timings,
no coverage stamp, so graders that read tool facts have nothing to read.
No declared delay, so latency numbers from a mocked run flatter you.

**And the honest caveat: that guard couples your agent's source to the
exact shape of Egma's dispatch metadata today.** If the metadata grows or
moves, your agent breaks in a way no test of yours would catch. That
coupling is precisely what `mockable` exists to own — the shape stays
Egma's to evolve, and your side stays one line.

Use the recipe as the bridge, not as the small tier.

## Compatibility

This package pins `livekit-agents` to one minor version
(`>=1.6.7,<1.7`), and that is deliberate. Interception uses LiveKit's
testing API. Monitoring also reads LiveKit's current dynamic tracer
provider because the public telemetry API has a setter but no getter.
The fixture and live tests verify both seams before the supported range
changes.

The package also keeps the OpenAI Python package on major version 2.
LiveKit Agents 1.6 does not support OpenAI 3.

`mock_tools` writes into a side table LiveKit keeps per session. It does
not touch your agent, your agent's class, or your tool registry, and the
model keeps seeing your real tool schemas throughout. Never calling it
leaves everything byte for byte as it was, which is what makes the inert
path literal.

If that API ever moves, the documented fallback is
`Agent.update_tools(...)` with `function_tool(raw_schema=...)` wrappers
built from the real tools' schemas. It is a heavier mechanism — it takes
responsibility for schema fidelity, for the real implementations, and for
re-wrapping after a handoff — which is exactly why it is the fallback and
not the mechanism.

## Developing this package

The toolchain is [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run ruff check src tests
uv run pytest
```

The normal suite is hermetic: no LiveKit server, no project, and no external
network. One monitoring test uses a local HTTP collector. One live test skips
visibly when the environment is silent, naming what it needs. To run it, point
it at a LiveKit project:

```bash
TEST_LIVEKIT_URL=wss://... \
TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \
TEST_MODEL_API_KEY=... \
uv run pytest tests/test_live_mockable.py -v
```

Each name falls back to the plain one the tool's own CLI reads —
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`
— so one environment serves this and whatever else you run beside it.
`TEST_MODEL_NAME` picks the model; it defaults to `gpt-4o-mini`.

## License

Apache-2.0, with the rest of Egma.
