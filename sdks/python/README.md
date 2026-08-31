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
pip install 'egma @ git+https://github.com/egma-ai/egma.git#subdirectory=sdks/python'
```

This source request has no version, tag, or commit. Let the repository's
package manager resolve and lock the latest compatible SDK.

For a LiveKit agent on Python 3.11 or newer.

## Production monitoring

Open **Agents → Connect an agent**, choose **Monitoring** or **Both**, and then
choose **LiveKit**. The guided flow shows these worker, key, and deployment
steps. A LiveKit agent pushes its own spans, so there is nothing to switch on
in Egma.

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

Call `monitor_livekit` as the first statement of the job entrypoint, before
`ctx.connect` and `AgentSession.start`:

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

If this job runs in an Egma simulation room, the helper returns without
adding a production exporter and says so at `WARNING`. The simulation keeps
its own trace and does not appear a second time in Monitoring.

The helper reads the room's name for that and nothing else. Every Egma
simulation room is named `egma-sim-…`; a room named anything else gets the
production exporter. The name arrives with the job, so this decision costs
no network and happens before `ctx.connect()`.

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

### How it knows it is in a simulation

It reads the **room's name** off the job. Every room Egma conducts a
simulation in is named `egma-sim-…`, and that prefix is fixed. Nothing
else is read, nothing is asked, and no room is connected to find out.

The name is the signal because it is the one that arrives on every
dispatch path an agent can end up in an Egma room by — whether Egma
dispatches your worker by name, whether LiveKit walks an unnamed worker
into the room, and whether your own token endpoint puts the agent there.
A signal carried by an explicit dispatch arrives on only the first of
those.

In a simulation room, `mockable` connects the job with LiveKit's own
`JobContext.connect()` if your startup has not already done so, then finds
Egma among the room's participants: Egma joins as `egma-persona` or
`egma-persona-<simulation>`. On two of the three dispatch paths your
agent is in the room **before** Egma, so it waits for that participant,
for up to 45 seconds and without polling anything outside the room. That
is a long time to hold an agent before it greets anybody, and it is the
price of the wait being correct on every dispatch path rather than on one;
a simulation ordinarily pays a fraction of it. It does not reconnect an
already-connected room, and it never connects a production room.

If nobody by that name arrives, nothing is wrapped, your tools all run
their own implementations, and the reason is logged at `ERROR`. If two
participants answer to that name, the exchange is refused for the same
reason a room with two claimants has no knowable answer — and your tool
inventory is not sent to either of them.

Then `mockable` reports your agent's tools to Egma — names and schemas,
read off the agent object, so mock authoring starts from your real tool
names instead of your memory of them — and learns which of them this
simulation answers for. Calls to those tools go to Egma and come back with
the authored answer. Every one of them lands on the simulation's record
with its arguments, its answer, how long it took, and which mock tool
answered.

**In every other room it does nothing at all.** A room your own system
named — which is every production room — is a room where `mockable`
returns having touched nothing: no wrapper, no message, no connect. Your
tools are the same objects, called the same way, with no wrapper between
them and the model. Zero added latency, by construction rather than by
care. That property is a test in this package (`tests/test_inert.py`),
not a promise in this file.

Your job's **dispatch metadata is yours**. This SDK writes nothing into it
and reads nothing out of it — not one key, in any room, for any purpose.
Neither does Egma: on every dispatch path, both the room's metadata and
the dispatch's carry the string configured on the connection, byte for
byte. `json.loads(ctx.job.metadata)["your_key"]` reads the same thing in a
simulation that it reads in production.

### Where to call it

After the agent object exists and before `session.start`. The report of
your tools is the first thing said, so an Egma that is not in the room is
discovered before any tool call rather than half way through a test.

Keep one `mockable` call for the initial agent. The SDK follows LiveKit's
public handoff events and installs the same simulation couriers for each
selected `Agent` or `AgentTask` before that activity starts. Each handoff
also extends one cumulative tool census, so Egma's coverage record keeps
the tools found on earlier agents.

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

`ERROR` is reserved for a simulation that could not be isolated and can
be acted on — no Egma participant arrived in a simulation room, two
participants claimed to be Egma, or the two halves do not speak the same
version of the exchange. None of those lines is reachable in a production
room.

## Before you install anything: the interim recipe

You can get isolation today with no Egma code at all, using LiveKit's own
`mock_tools` and a guard you write yourself:

```python
from livekit.agents import mock_tools


def in_a_simulation(ctx: agents.JobContext) -> bool:
    return ctx.job.room.name.startswith("egma-sim-")


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

A room your own system named means the guard is false and nothing is
wrapped. Note where that safety comes from, because it is not where
`mockable`'s comes from: this guard fires on a prefix being *present*
rather than on Egma being *absent*. So it is true in any room whose name
begins `egma-sim-`, including one Egma is not in — `mockable` waits for
Egma's participant and gives up out loud, while this guard has nobody to
wait for and simply mocks. Refuse that prefix wherever your own side mints
production tokens, or a production room named to look like a simulation
runs your canned answers against a live caller.

**Write the guard on the room name, and not on `egmaIdentity` in
`ctx.job.metadata`.** That key is in no simulation room at all: your
dispatch metadata is yours, and Egma writes nothing into it on any
dispatch path. A guard on it does not raise — it quietly fails to fire,
and every real tool it was meant to hold back runs inside a simulation.

What it cannot do is the rest of the job. One canned world for every
test, so you cannot write "the calendar is full" as a *test* — you would
be editing your agent's source to change a test's data. Nothing about
those calls reaches Egma's record: no arguments, no answers, no timings,
no coverage stamp, so graders that read tool facts have nothing to read.
No declared delay, so latency numbers from a mocked run flatter you.

**And the honest caveat: that guard couples your agent's source to how
Egma announces itself.** The room-name prefix is a stated contract rather
than an implementation detail, so it is the safe thing to key off — but
the *rest* of the mechanism is not: where Egma sits in the room, what
it is called, how long it takes to arrive, and what a room with two
claimants means are all Egma's to evolve. That is precisely what
`mockable` exists to own, and your side stays one line.

Use the recipe as the bridge, not as the small tier.

## Compatibility

The `egma-sim-` room-name prefix is a stated contract, not an internal
detail. Every room Egma opens for a simulation begins with it, on every
dispatch path, and it is there to be relied on and to be allowlisted in
a token endpoint. This SDK keys its whole simulation/production decision
off it.

Every Egma deployment names its rooms that way, so this package works
against a self-hosted Egma on whatever schedule its owner upgrades it.
Nothing else is consulted — in particular, neither metadata channel,
which carries your own configured JSON and nothing of Egma's.

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
