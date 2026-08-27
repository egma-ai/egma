# Add the Egma SDK to a LiveKit worker

The Egma Python SDK has two separate entries:

| Entry | Purpose | Position |
| --- | --- | --- |
| `await mockable(agent, ctx, session)` | Serve mock tools during an Egma simulation | After the agent and `AgentSession` exist; before `AgentSession.start` |
| `monitor_livekit(ctx)` | Send production evidence to Egma | First statement of the job entrypoint; before `ctx.connect()` |

Add only the entry requested by the task. The Python package is named `egma`.
Add it through the dependency file the repository already uses. The Egma SDK
does not yet support a worker built with `@livekit/agents`; report that boundary
and leave a Node worker unchanged.

## Find the job entrypoint

Use the entrypoint found during discovery. Confirm it from one or more of these
facts before editing:

- a function passed as `entrypoint_fnc` to `WorkerOptions`;
- a `JobContext` function that connects to LiveKit;
- an `AgentSession` created and started on that path;
- a server registration or `cli.run_app` that reaches the function.

When several workers remain possible, ask the developer which one to change.

## Testing entry

```python
from egma import mockable

async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    agent = FrontDesk()
    session = AgentSession(...)
    await mockable(agent, ctx, session)
    await session.start(agent=agent, room=ctx.room)
```

The entry must be awaited. Both objects must already exist. It must run before
`AgentSession.start`, so Egma receives the tool list before the first tool can
run.

## Monitoring entry

```python
from egma import monitor_livekit

async def entrypoint(ctx: agents.JobContext) -> None:
    monitor_livekit(ctx)
    await ctx.connect()
```

The monitoring entry is synchronous and is the first statement of the
entrypoint. Its process receives `EGMA_URL` and `EGMA_API_KEY`. Name those
variables when needed. Egma owns their values and environment injection.

## Protect credentials

Accept `EGMA_URL` and `EGMA_API_KEY` only through the process environment Egma
supplies. Keep both values out of changed files and command output.

## When the entrypoint is unknown

Leave the repository unchanged. Name where you looked and provide the exact
dependency, import, and entry lines for the developer to add. Do not guess a
worker file.

Read changed files back. Confirm the dependency, import, entry position, and
requested mode. Finish when the requested entry is present and no other mode
was added.
