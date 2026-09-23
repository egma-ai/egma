# Guide to setup production monitoring for voice agents with egma platform

Monitoring sends the agent's real production conversations to egma, where the developer reads them under **Traces** and graders with production scope grade them. It needs no test suite and no connection.

The broad order is:
1. Make sure the `egma/` folder exists and is in sync (`egma init` if it is missing, else `egma pull`). Check `egma/config.yaml` for the agent. If it is not registered, register it with `egma agent register --platform <retell|livekit|pipecat> --name "<name>"`.
2. Follow the section for the agent's platform below.
3. Verify with one real conversation.

If the developer also wants simulation testing, do monitoring first and continue with testing in the same piece of work. Reuse the same project API key and environment values for both.

## LiveKit and Pipecat: the SDK sends production traces

For LiveKit and Pipecat, monitoring is code in the agent. There is no switch in egma to turn on; the first trace that arrives confirms the setup. Do not use `egma agent monitoring setup` for these platforms.

### 1. Create a project API key and set the environment

1. Create a key: `egma project api-key create --name "<agent name> monitoring"`. It is printed once and the CLI does not save it. If simulation testing already created a key for this agent, reuse it.
2. The agent needs two values wherever it runs in production:
   - `EGMA_URL` - `https://api.egma.ai`, or the developer's self-hosted egma API URL. The deployed agent must be able to reach it.
   - `EGMA_API_KEY` - the project key.
3. Put them where the repo already keeps the agent's deployed secrets: the LiveKit worker's secret store, the Pipecat Cloud secret set named `secret_set` in `pcc-deploy.toml` (`pipecat cloud secrets set <secret_set> EGMA_URL=... EGMA_API_KEY=...`), or the team's own server environment. Never commit the key and never print it in your messages. If you are not allowed to change deployed secrets, hand this step to the developer with the exact names.

### 2a. LiveKit worker

- Python: install `egma[livekit]` with the repo's package manager (supports `livekit-agents>=1.6.6,<1.9`). Add `from egma.livekit import monitor` and make `monitor(ctx)` the first statement of the job entrypoint, before `ctx.connect()` and `session.start(...)`. The older `from egma import monitor` also works; do not rewrite an existing import only for that.
- JavaScript/TypeScript: install `@egma/livekit` (needs Node.js 22+ and `@livekit/agents>=1.5.5 <2`). Add `import { monitor } from "@egma/livekit";` and call `monitor(ctx, { session })` after creating the session, before `ctx.connect()` and `session.start(...)`.
- `monitor` does nothing in rooms named `egma-sim-…`, so simulations never appear twice. If the worker also runs simulations, keep both `monitor` and `simulation`.
- Keep LiveKit's default of one job per process.

### 2b. Pipecat bot

- Install `egma[pipecat]` with the repo's package manager (supports Python 3.11+ and `pipecat-ai>=1.9,<1.12`).
- Add `from egma.pipecat import monitor` and call `await monitor(worker, runner_args)` after the bot creates its `PipelineWorker(...)` and before `runner.add_workers(worker)`. `runner_args` is the argument of `bot(runner_args)`; pass it into the helper that builds the worker if needed.
- If the bot also runs simulations, call `await simulation(worker, runner_args)` first, then `await monitor(worker, runner_args)`.
- `monitor` exports every session whose start request has no `egma` key, with no extra network request. When a body carries an `egma` key, it stays silent only if egma confirms a live simulation; anything else is exported as production.

### 3. Deploy and verify

1. The code and the two values reach production only after a deploy (for Pipecat Cloud, for example `pipecat cloud deploy` after the secret set is updated). Deploy only when you were explicitly allowed to; otherwise hand the deploy over to the developer.
2. After one real production conversation, open **Traces** in the egma project that owns the key and check that the conversation arrived with its transcript and tool calls.
3. If nothing arrives, check the agent's logs, the project key, and that the deployed agent can reach `EGMA_URL`.
4. To grade production conversations, the project needs graders with production scope. Point the developer to the graders page if none are set.

To stop monitoring later, remove the `monitor` call and redeploy. Stored conversations stay in egma.

## Retell: egma imports completed calls

For Retell, monitoring is a switch in egma; the agent's code does not change.

1. If the egma agent already has a Retell connection, run `egma agent monitoring setup --agent "$EGMA_AGENT_ID" --platform retell`. It reuses the stored Retell key and agent ID.
2. For monitoring without a connection, load the repo's Retell API key into `EGMA_RETELL_API_KEY` (or pass `{"apiKey":"..."}` with `--credentials-stdin`), find the exact Retell agent ID with `egma agent connection options --platform retell`, and run `egma agent monitoring setup --agent "$EGMA_AGENT_ID" --platform retell --retell-agent "<Retell agent ID>"`.
3. Setup imports completed calls from the last 30 days, then checks for new calls about every 30 seconds. Verify under **Traces**.

To stop imports later, run `egma agent monitoring stop --agent "$EGMA_AGENT_ID" --platform retell`.
