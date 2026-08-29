# Egma SDK for LiveKit Agents JS

Send production traces from a LiveKit Agents JS worker to Egma Monitoring.

## Install

```bash
npm install @egma/livekit
```

This release supports Node.js 22 or newer and `@livekit/agents>=1.7.1 <1.8`.
The LiveKit range is narrow on purpose. The SDK shares LiveKit's current
OpenTelemetry provider and must verify each new LiveKit minor before it can
claim that the two exporters still coexist.

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

The helper sends OTLP/HTTP protobuf batches to `/v1/traces` and flushes its
last batch when the LiveKit job stops. It creates the shared tracer provider
before the session starts and leaves a fan-out point for LiveKit Cloud
observability. If another integration already installed a provider, it stops
with a safe setup error instead of replacing that provider.

Rooms whose names start with `egma-sim-` are simulations. Their traces stay on
the simulation record and are not sent through production Monitoring.

## Current testing boundary

This first JavaScript release does not provide Python's `mockable` function.
LiveKit Agents JS 1.7 exposes test mocks through one module-wide table keyed by
the exact agent constructor, not by session. Standard worker jobs run in their
own child processes, but repeated or overlapping sessions inside one job can
still replace each other's mocks, and nested cleanup can restore stale mocks.
Egma therefore keeps Node simulation testing blocked instead of claiming
session isolation that the upstream hook does not provide.
