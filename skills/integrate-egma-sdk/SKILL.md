---
name: integrate-egma-sdk
description: Add the Egma Python SDK to a LiveKit Agents worker — the testing entry so Egma can serve mock tools during a simulation, and the monitoring entry so production traffic reaches Egma. Use when wiring Egma into a LiveKit voice agent's job entrypoint, or when the entrypoint cannot be found and the developer needs the lines to add by hand.
---

# Integrate the Egma SDK into a LiveKit worker

The Egma SDK is the piece of Egma that lives inside the developer's own voice
agent process. It has two public entry points and they are deliberately
separate:

| Entry | What it is for | Where it goes |
| --- | --- | --- |
| `await mockable(agent, ctx, session)` | testing — lets Egma answer for the agent's tools during a simulation | after the agent and the `AgentSession` object exist, before `AgentSession.start` |
| `monitor_livekit(ctx)` | monitoring — sends this worker's production evidence to Egma | at the top of the job entrypoint, before `ctx.connect()` |

Add only the entry the developer's task asks for. The testing entry never turns
on production export, and the monitoring entry never serves a mock tool. Wiring
one in the hope that it does the other's job is the one mistake this skill
exists to prevent.

## Install the package

The SDK is published as `egma` for Python. Add it the way this repository
already adds dependencies — `pyproject.toml`, `requirements.txt`, or whatever
the repository uses — and do not switch the repository to a different tool to
do it.

```toml
dependencies = ["egma"]
```

Do not pin a version unless the developer asks for one.

## Find the job entrypoint

A LiveKit Agents worker has one function registered as the job entrypoint. Find
it by evidence, not by file name:

- a function passed as `entrypoint_fnc` to `WorkerOptions`, which is the
  definitive marker;
- a function taking a `JobContext` — usually named `ctx` — that awaits
  `ctx.connect()`;
- an `AgentSession` built in that same function, and started with
  `AgentSession.start`.

If several workers are defined, ask the developer which one Egma should reach.
Do not edit more than one.

## The testing entry

```python
from egma import mockable

async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    agent = FrontDesk()
    session = AgentSession(...)
    # Both objects exist and nothing has been said yet.
    await mockable(agent, ctx, session)
    await session.start(agent=agent, room=ctx.room)
```

Three rules about the position, and all three are load-bearing:

1. **After the agent object and the `AgentSession` object both exist.** Egma
   reads the agent's tools off the agent object, so an earlier line reports a
   tool list that is not yet complete.
2. **Before `AgentSession.start`.** The tool list has to have reached Egma
   before the model can reach for its first tool.
3. **Awaited.** It is an `async` function and the wait is structural, not
   decoration. Dropping the `await` means the tool list races the first turn.

Outside a simulation this line returns having touched nothing: production
behavior is unchanged, the same tool objects are invoked the same way, and no
wrapper stands between the model and the developer's code. That is what makes
it safe to leave in a worker that is also serving real traffic.

## The monitoring entry

```python
from egma import monitor_livekit

async def entrypoint(ctx: agents.JobContext) -> None:
    monitor_livekit(ctx)
    await ctx.connect()
```

Two rules:

1. **At the top of the entrypoint**, before `ctx.connect()` and before the
   `AgentSession` is built.
2. **Not awaited.** It is an ordinary function.

It reads two environment variables in the process it runs in: where Egma is,
and the project API key to reach it with. **Do not name them, do not set them,
do not read them, and do not add them to any file.** Egma's own command writes
them where they belong and prints them for the deployment environment; see the
next section.

## Never touch `.env`

`.env` files hold live credentials. This skill's work never needs one:

- **Never read** a `.env`, `.env.local`, `.env.production` or any other
  environment file, with an editor, a shell command, or anything else.
- **Never write** one, and never add a variable to one.
- **Never print** a value read from one.

Egma's own CLI writes the environment lines a monitored worker needs, with the
developer's agreement, and refuses when the file is not ignored by Git. Work
from committed source and from what the developer tells you, and nothing else.

## When the entrypoint cannot be found

Do not guess and do not edit a file you are not sure about. A worker wired in
the wrong place looks integrated and serves nothing.

Say plainly that you could not find the job entrypoint, name where you looked,
and give the developer the exact lines to add by hand:

```text
Add the Egma SDK to your LiveKit worker by hand:

1. Add "egma" to your Python dependencies.
2. In your job entrypoint, after the agent and the AgentSession object exist
   and before AgentSession.start, add:

       from egma import mockable

       await mockable(agent, ctx, session)

3. For production monitoring, at the top of the same entrypoint, before
   ctx.connect(), add:

       from egma import monitor_livekit

       monitor_livekit(ctx)
```

Give the same block whether the repository has no worker you can identify, or
several and no way to choose between them.

## Check the edit

Read the changed file back and confirm each of these:

- the import is at the top of the file, beside the repository's other imports;
- the testing entry is awaited, after both objects exist, before
  `AgentSession.start`;
- the monitoring entry is not awaited, and is the first statement of the
  entrypoint;
- nothing else in the file changed;
- no environment file was opened, written, or mentioned.

Report the file you edited and the one line you added to it. If the repository
has a type checker or a linter the developer already runs, running it on the
changed file is welcome; installing one is not.
