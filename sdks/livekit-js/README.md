# Egma SDK for livekit JS agents

This SDK connects your livekit agent to egma for simulation testing and production monitoring. It records the agent's POV during simulations and lets egma inject mock tools.

We need to do four things to set it up.

## 1. Install the SDK

Install the latest compatible release in the repo where your livekit worker runs. Use the package manager the repo already uses.

```bash
npm install @egma/livekit@latest
```

For a repo using pnpm:

```bash
pnpm add @egma/livekit@latest
```

The SDK needs Node.js 22 or newer. Both `simulation` and `monitor` require `@livekit/agents>=1.5.5 <2`, even though the package's peer range starts at 1.5.0. Check compatibility with the worker's existing dependencies before upgrading and keep the resolved versions in the repo's lockfile.

## 2. Setup the worker's environment

Use an egma API key scoped to the project you want to send data to. You can create it through the CLI or the UI.

- **CLI:** from a repo with a logged-in egma CLI and the right project in `egma/config.yaml`, run the command below. Use `egma login` if you need to sign in, and `egma init` if the repo does not have a project setup yet.

  ```bash
  egma project api-key create --name livekit-worker
  ```

- **UI:** open your project in [egma](https://app.egma.ai), go to **Settings → API keys**, enter a name, select your project under **Scope**, and click **Create key**.

Copy the key when it is shown. The secret is shown once, and the CLI does not save it.

Set these values in the worker's environment:

```bash
EGMA_URL=https://api.egma.ai
EGMA_API_KEY=<your project API key>
```

For self-hosted egma, use your egma API URL. The worker must be able to reach it. Put the key in the worker's secret store or a gitignored environment file. For a cloud worker, set it in the deployed environment as well.

## 3. Add the integration

There are two functions depending on what you want to setup.

### A. Simulation testing

Call and await `simulation(agent, ctx, session)` after creating the agent and session, before `session.start`. Add this around the existing start call in your job entrypoint:

```typescript
import { simulation } from "@egma/livekit";

await simulation(agent, ctx, session);
await session.start({ agent, room: ctx.room });
```

This is required for every voice and text simulation, even when the test has no mock tools. It sends the agent's traces to the simulation and lets egma answer the tools named under `## Mock tools` in the test. Other tools run their real implementations and are recorded too.

The SDK recognises simulation rooms by the `egma-sim-` prefix. In other rooms, `simulation` does nothing. Keep that prefix reserved for egma simulations.

For text simulations, disable audio and transcription pacing in `egma-sim-chat-` rooms. Use this start call, keeping your normal voice settings in the other branch:

```typescript
const isEgmaChat = ctx.job.room?.name?.startsWith("egma-sim-chat-") ?? false;

await session.start({
  agent,
  room: ctx.room,
  ...(isEgmaChat
    ? {
        inputOptions: { audioEnabled: false },
        outputOptions: { audioEnabled: false, syncTranscription: false },
      }
    : {}),
});
```

Keep the `await simulation(...)` call before this start call. Turn off any separate audio publishers in the text branch too.

If the worker cannot complete the handshake with egma, `simulation` throws `NotReported`. Fix the setup before starting the session. If a mocked tool cannot reach egma during a simulation, that tool errors instead of calling the real backend.

`simulation` has no total startup deadline. It waits for Egma to join and accept the tool configuration while the simulation room stays active. A room disconnect or Egma participant departure stops the wait. Each RPC attempt keeps its own transport timeout, and transient registration or delivery failures are retried with the same configuration.

When the configured simulation ends, Egma finishes its pending output and leaves the room. The SDK then closes the `AgentSession` that you supplied. An abrupt room disconnect closes it too. This completes LiveKit's native session trace and lets an entrypoint that waits for session close finish without its own timer. The listener is installed only after the exact Egma participant has accepted the tool report, and it is never installed in a production room.

### B. Production monitoring

Call `monitor(ctx)` at the start of the job entrypoint, before `ctx.connect` and `session.start`:

```typescript
import { monitor } from "@egma/livekit";

monitor(ctx);
```

It sends production traces to egma Monitoring. It does nothing in simulation rooms.

If you want both testing and monitoring, add both calls: `monitor(ctx)` at the start of the entrypoint, then `await simulation(agent, ctx, session)` before the session starts. Both use the same environment settings.

Keep LiveKit's default of one job per process. The SDK's exporter and mock tools use process-wide state, so overlapping jobs cannot share a worker process.

### If the worker already exports traces

Use a mutable span processor on the existing provider so egma can add its exporter. Pass that provider and its registrar to `monitor` and `simulation` wherever you call them:

```typescript
import { monitor, simulation } from "@egma/livekit";
import { telemetry } from "@livekit/agents";
import { NodeTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-node";

const fanout = new telemetry.FanoutSpanProcessor();
const provider = new NodeTracerProvider({
  spanProcessors: [yourExistingProcessor, fanout],
});
provider.register();

const options = {
  existingTelemetry: {
    provider,
    registerSpanProcessor: (processor: SpanProcessor) => fanout.add(processor),
  },
};

monitor(ctx, options);
await simulation(agent, ctx, session, options);
```

Build the provider with this arrangement where your worker configures telemetry. The registrar must add to the exact provider you pass. Egma keeps LiveKit Cloud observability enabled and refuses an incompatible provider instead of replacing it.

## 4. Run the updated worker and verify

For simulations, register the agent and a connection in egma if you have not already done so. Start the updated worker with an explicit `agentName` matching that connection. Supply the job dispatch metadata your worker needs for startup.

Keep a local worker running during tests. To use a cloud worker, deploy the SDK changes and environment settings there first. A successful local run does not deploy those changes.

- **Testing:** run a simulation, wait for it to finish, and check that it completed with the agent's POV. If the agent calls a mocked tool, check its recorded arguments and answer too.
- **Monitoring:** make a production conversation and check that it appears in egma Monitoring.

If no worker joins, check the worker process and agent name. If the handshake fails, check the SDK call and room connection. If traces are missing, check the project key, `EGMA_URL`, and the worker's export logs.

## License

MIT. See [LICENSE](https://github.com/egma-ai/egma/blob/main/sdks/livekit-js/LICENSE).
