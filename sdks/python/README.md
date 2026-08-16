# Egma

Your agent's tools, answered by Egma while a test runs.

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

## Install

```bash
pip install egma
```

For a LiveKit agent, on Python 3.11 or newer.

## Use

One call, after the agent is built and before the session starts:

```python
from egma import mockable
```

```python
async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()

    agent = Agent(instructions=INSTRUCTIONS, tools=[check_calendar, book_appointment])
    session = AgentSession(stt=..., llm=..., tts=...)

    await mockable(agent, ctx, session)

    await session.start(agent=agent, room=ctx.room)
```

That is the whole integration.

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

- Goes to Egma over the room you are already in. No new endpoint, no new
  credential, nothing new to expose.
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
(`>=1.6.7,<1.7`), and that is deliberate. Interception is done with
LiveKit's own `mock_tools`, which lives in the framework's testing
namespace and carries no stability promise. The pin plus a live smoke
test — a real session in a real room, proving that interception really
happened — is how this package knows the mechanism still works before
you find out in a simulation.

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

The suite is hermetic: no LiveKit server, no project, no network. One
test is not, and it skips visibly when the environment is silent, naming
what it needs. To run it, point it at a LiveKit project:

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
