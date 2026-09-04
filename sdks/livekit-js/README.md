# Egma SDK for LiveKit Agents JS

Test LiveKit Agents JS workers with Egma mock tools and send production traces
to Egma Monitoring.

## Install

```bash
npm install @egma/livekit
```

The package needs Node.js 22 or newer.

| Helper | Supported `@livekit/agents` versions |
|---|---|
| `mockable` | `>=1.5.0 <2` |
| `monitorLiveKit` | `>=1.5.5 <2` |

The package peer range begins at `1.5.0` because that is the first stable
LiveKit Agents JS release with `voice.testing.withMockTools`. Production
monitoring begins at `1.5.5`, the first release with LiveKit's public
OpenTelemetry fan-out bridge. Calling `monitorLiveKit` on an older supported
version gives a direct version error. You do not need to pin to `1.6.4`.
The upper bound is LiveKit's next major release, not its next minor release:
Egma uses these public v1 APIs as one compatible line. CI pins the exact
minimum, each available minor boundary, and the latest tested v1 release.

## Use mock tools in simulations

Call `mockable` once after you create the agent and session, and before
`session.start`:

```typescript
import { mockable } from "@egma/livekit";
import { type JobContext, voice } from "@livekit/agents";

export async function entrypoint(ctx: JobContext) {
  const isEgmaChat =
    ctx.job.room?.name?.startsWith("egma-sim-chat-") ?? false;
  const agent = voice.Agent.create({
    instructions: "Help the caller.",
    tools: [checkCalendar, bookAppointment],
  });
  const session = new voice.AgentSession({ stt, llm, tts });

  await mockable(agent, ctx, session);
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

In an `egma-sim-` room, the helper connects if needed, reports the agent's tool
names and schemas, and asks Egma which tools this simulation answers for. Egma
replies with exactly the tool names the running test writes under `## Mock
tools`, and the helper uses LiveKit's own mock-tool hook for those names only.
It follows agent handoffs in the same session.

Egma wraps exactly the tools the running test names. Every other tool runs its
real implementation, and Egma is not in that path. A mock tool whose name never
matches one of the agent's tools runs nothing and leaves no trace.

The worker reads the running test's `job_dispatch_metadata` at
`ctx.job.metadata`, as one compact JSON string. With Project credentials, Egma
writes it directly to the dispatch. With a token endpoint, Egma sends it in the
request's `room_config` and the endpoint copies that configuration into the
token it mints. Egma adds no key of its own there and leaves the room's metadata
empty.

In every other room, `mockable` returns before it connects, sends a message, or
wraps a tool. That is the production safety boundary.

| Situation | Result |
|---|---|
| Production room | Nothing changes |
| Simulation tool the test names | Egma answers |
| Simulation tool the test does not name | The real tool runs |
| Egma cannot be reached during a call | The real tool runs |
| Egma receives the call and refuses it | The tool raises `ToolError` |

LiveKit stores JavaScript mock tools in process-wide state. A normal LiveKit job
runs in its own child process, so separate calls do not share that state. Egma
also claims one active mockable session per job process and refuses a second
overlapping session. Cleanup runs when the session closes or the job shuts
down.

## Monitor production agents

Set the Egma API origin and a project API key where the worker runs:

```bash
export EGMA_URL=https://api.egma.ai
export EGMA_API_KEY=egma_sk_...
```

Call `monitorLiveKit` as the first statement of the job entrypoint, before
`AgentSession.start`:

```typescript
import { monitorLiveKit } from "@egma/livekit";
import { type JobContext, voice } from "@livekit/agents";

export async function entrypoint(ctx: JobContext) {
  monitorLiveKit(ctx);

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
monitorLiveKit(ctx, {
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

monitorLiveKit(ctx, {
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
