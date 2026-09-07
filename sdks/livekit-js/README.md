# Egma SDK for LiveKit Agents JS

Test LiveKit Agents JS workers with Egma mock tools and send production traces
to Egma Monitoring.

## Install

```bash
npm install @egma/livekit
```

The package needs Node.js 22 or newer.

| Verb | Supported `@livekit/agents` versions |
|---|---|
| `simulation` | `>=1.5.5 <2` |
| `monitor` | `>=1.5.5 <2` |

The package peer range begins at `1.5.0` because that is the first stable
LiveKit Agents JS release with `voice.testing.withMockTools`. Both verbs
export spans, so both need `1.5.5`, the first release with LiveKit's public
OpenTelemetry fan-out bridge. Calling either on an older supported version
gives a direct version error. You do not need to pin to `1.6.4`.
The upper bound is LiveKit's next major release, not its next minor release:
Egma uses these public v1 APIs as one compatible line. CI pins the exact
minimum, each available minor boundary, and the latest tested v1 release.
One compatibility job builds the package once and checks those versions in
parallel, using a separate installation for each version.

## Upgrading from 0.2

Version 0.3 replaces `mockable` with `simulation` and `monitorLiveKit` with
`monitor`. The options type is now `MonitorOptions`. Update the imports and
calls; the old names are no longer exported.

`simulation` now also exports the agent's traces. Set `EGMA_URL` and
`EGMA_API_KEY`, or pass `endpoint` and `apiKey`, before calling it. Both
functions require LiveKit Agents JS 1.5.5 or newer within v1. A simulation
that cannot report its tools raises `NotReported` before the session starts.

## Run a simulation

Call `simulation` once after you create the agent and session, and before
`session.start`:

```typescript
import { simulation } from "@egma/livekit";
import { type JobContext, voice } from "@livekit/agents";

export async function entrypoint(ctx: JobContext) {
  const isEgmaChat =
    ctx.job.room?.name?.startsWith("egma-sim-chat-") ?? false;
  const agent = voice.Agent.create({
    instructions: "Help the caller.",
    tools: [checkCalendar, bookAppointment],
  });
  const session = new voice.AgentSession({ stt, llm, tts });

  await simulation(agent, ctx, session);
  await session.start({
    agent,
    room: ctx.room,
    ...(isEgmaChat
      ? {
          inputOptions: { audioEnabled: false },
          outputOptions: {
            audioEnabled: false,
            syncTranscription: false,
          },
        }
      : {}),
  });
}
```

The `egma-sim-chat-` branch keeps chat simulations on LiveKit's text path.
Keep independent audio publishers off in that branch too. Other room names use
the worker's normal voice settings.

It reads `EGMA_URL` and `EGMA_API_KEY`, the same two settings `monitor`
reads, or the matching `endpoint` and `apiKey` options.

In an `egma-sim-` room, the verb installs the span export, connects if needed,
reports the agent's tool names and schemas, and asks Egma which tools this
simulation answers for. Egma replies with exactly the tool names the running
test writes under `## Mock tools`, and the verb uses LiveKit's own mock-tool
hook for those names only. It follows agent handoffs in the same session.

**It is required, and it fails closed.** Every way the exchange can end
without a hello Egma answered throws `NotReported`, so the session never
starts and Egma ends that simulation with the same finding from its own side.
A simulation that ran without reaching Egma would have called your real
backends everywhere a mock tool was meant to answer, and its record would say
nothing about it.

### What it sends to Egma

The agent's own spans, over OTLP, to `EGMA_URL` with your project API key —
the same road `monitor` uses. Each span carries the room's name, so Egma files
them under the simulation that opened that room. They are batched at one
second and flushed when the session closes and again when the LiveKit job
stops, so the end of a conversation lands in Egma within a second or two of
the caller leaving.

That is the **agent's POV** of the simulation: its turns, its tool calls, its
own timings. Egma stores it beside what its own caller heard and shows it on
the simulation.

Egma wraps exactly the tools the running test names. Every other tool runs its
real implementation, and Egma is not in that path. A mock tool whose name never
matches one of the agent's tools runs nothing and leaves no trace.

**Unmocked tools run real, and are recorded from the agent's POV.** The record
of a simulation is the agent's own account of the conversation, so every call it
made is on it, with the arguments the model sent and the result it received. A
call a mock tool answered is marked `mocked`, beside the tool's own name; a
call Egma
refused shows as the error this package threw on it.

The worker reads the running test's `job_dispatch_metadata` at
`ctx.job.metadata`, as one compact JSON string. With Project credentials, Egma
writes it directly to the dispatch. With a token endpoint, Egma sends it in the
request's `room_config` and the endpoint copies that configuration into the
token it mints. Egma adds no key of its own there and leaves the room's metadata
empty.

In every other room, `simulation` returns before it connects, exports, sends a
message, or wraps a tool. That is the production safety boundary.

| Situation | Result |
|---|---|
| Production room | Nothing changes |
| Simulation tool the test names | Egma answers |
| Simulation tool the test does not name | The real tool runs |
| Egma cannot be reached during a call | The call raises `ToolError`; the real tool does not run |
| Egma receives the call and refuses it | The tool raises `ToolError` |
| Egma never answers the hello | `simulation` throws `NotReported`; the session does not start |

### One LiveKit job per process

Two things here are process-wide and neither can be made per-job. LiveKit
stores JavaScript mock tools in process-wide state, keyed by agent class. And
the exporter's resource carries the room this process files spans under, and
is fixed when the tracer provider is built.

A normal LiveKit job runs in its own child process, so this costs nothing —
and it is the arrangement both verbs are written for. A second overlapping
session is refused by the mock table; a second job in the same process is
refused by the exporter. Cleanup runs when the session closes or the job shuts
down.

## Monitor production agents

Set the Egma API origin and a project API key where the worker runs:

```bash
export EGMA_URL=https://api.egma.ai
export EGMA_API_KEY=egma_sk_...
```

Call `monitor` as the first statement of the job entrypoint, before
`AgentSession.start`:

```typescript
import { monitor } from "@egma/livekit";
import { type JobContext, voice } from "@livekit/agents";

export async function entrypoint(ctx: JobContext) {
  monitor(ctx);

  const session = new voice.AgentSession({
    stt: "deepgram/nova-3:en",
    llm: "openai/gpt-4.1-mini",
    tts: "cartesia/sonic-3",
  });
  await session.start({
    agent: voice.Agent.create({ instructions: "Help the caller." }),
    room: ctx.room,
  });
}
```

You can pass the settings directly when your deployment does not use
environment variables:

```typescript
monitor(ctx, {
  endpoint: "https://api.egma.ai",
  apiKey: projectKey,
});
```

If your process already has OpenTelemetry export, build that provider around
LiveKit's mutable fan-out and pass the same provider and registrar to Egma:

```typescript
import { telemetry } from "@livekit/agents";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const fanout = new telemetry.FanoutSpanProcessor();
const provider = new NodeTracerProvider({
  spanProcessors: [yourExistingProcessor, fanout],
});
provider.register();

monitor(ctx, {
  existingTelemetry: {
    provider,
    registerSpanProcessor: (processor) => fanout.add(processor),
  },
});
```

OpenTelemetry JS 2.x cannot add a processor to an already-built provider. The
registrar must add to the fan-out inside the exact provider you pass.

The helper sends OTLP/HTTP protobuf batches to `/v1/traces` and flushes its last
batch when the LiveKit job stops. It keeps LiveKit Cloud observability enabled.
If another integration installed a provider without a mutable seam, setup stops
with a safe error instead of replacing that provider.

Rooms whose names start with `egma-sim-` are simulations. Their traces stay on
the simulation record and are not sent through production Monitoring. Refuse
that reserved prefix when your own system creates production room names.
