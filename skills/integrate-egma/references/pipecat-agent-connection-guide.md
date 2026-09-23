# Connecting to a pipecat agent

We need to do four things to setup a pipecat bot for simulation testing.

1. Register the agent in the egma platform if it is not already registered.
2. Setup the egma SDK in the bot code. It is required for every pipecat simulation.
3. Add the connection(s) through which a simulated persona can reach the bot.
4. Run the first suite against the bot on this machine, before any deploy. Then hand over the deploy step.

## Important concepts to know first

A. How egma reaches a pipecat bot
  - A pipecat bot has no dispatch. For each simulation egma sends one start request to a starter. The starter creates a Daily room, starts the bot in it with `runner_args.body` = the request's `body`, and answers with the room URL. egma's persona joins that room. Only the Daily transport is supported, so the bot must build a `DailyTransport` for `DailyRunnerArguments`, as the pipecat quickstart does.
  - There are three ways to connect:
    1. Pipecat Cloud - egma sends the start request to Pipecat Cloud with the Pipecat Cloud agent name and a public API key (starts with `pk_`). Never use or ask for a private key (`sk_`).
    2. Self-hosted - egma sends the start request to a public HTTPS start URL with auth headers. Use it when the team runs its own bot starter on its servers.
    3. This machine - `egma agent dev` opens a Cloudflare quick tunnel to pipecat's development runner on this computer and creates this machine's voice and chat self-hosted connections for you. No deploy is needed.

B. Detect how the bot is deployed
  - If the repo has a `pcc-deploy.toml`, the bot runs on Pipecat Cloud. Its `agent_name` is the Pipecat Cloud agent name, `secret_set` is the secret set that holds the bot's environment, and `[scaling] min_agents` is how many instances stay warm.
  - If there is no `pcc-deploy.toml`, look for the team's own starter: an HTTP route that creates Daily rooms and starts `bot()`. Use a self-hosted connection for it. If you find neither, the bot only runs locally - use this machine.

C. Modalities
  1. Voice - runs a full voice simulation through the bot's STT, LLM and TTS.
  2. Chat - the persona sends text through RTVI. It needs no code beyond the SDK line: in a chat simulation the SDK turns the bot's speech output off by itself. It needs RTVI, which `PipelineWorker` turns on by default. If the bot passes `enable_rtvi=False`, or `rtvi_observer_params` with `bot_llm_enabled=False`, chat simulations fail; tell the developer.
  Create both a voice and a chat connection by default.

## 1. Register the agent if it is not already available

Check if the agent is already present in `egma/config.yaml`.
- If it is registered, move to step 2.
- If not, register it with `egma agent register --platform pipecat --name "<name>"`. Use `egma agent register --help` for the options.

## 2. Setup the egma SDK in the bot

1. Install `egma[pipecat]` with the package manager the repo already uses (for example `uv add "egma[pipecat]"`). The SDK supports Python 3.11+ and `pipecat-ai>=1.9,<1.12`. If the repo pins pipecat-ai outside that range, stop and tell the developer. The `pipecat` extra installs no livekit package.
2. Find where the bot creates its `PipelineWorker(...)` and where it calls `runner.add_workers(worker)`. Add `await simulation(worker, runner_args)` (with `from egma.pipecat import simulation`) between the two. `runner_args` is the argument of `bot(runner_args)`. If the worker is built in a helper, such as the quickstart's `run_bot(transport)`, add a `runner_args` parameter to it and pass it from `bot()`.

```python
from egma.pipecat import simulation

async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    ...
    worker = PipelineWorker(pipeline, params=PipelineParams(...))

    await simulation(worker, runner_args)

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments):
    ...
    await run_bot(transport, runner_args)
```

3. The line is inert in production: without an `egma` key in `runner_args.body` it makes no network request. It raises `NotReported` when it cannot report to egma, and the bot does not start. Do not catch it. Do not add code that reads or strips the `egma` key; the SDK owns it.
   - Pipecat Flows functions (from `pipecat.flows`) cannot be mocked yet. A simulation whose test mocks one fails when the flow first offers that function. Flows functions that are not mocked run for real and are recorded, so Flows bots still work; just never mock their functions.
4. If monitoring is also requested, add `await monitor(worker, runner_args)` right after the `simulation` line. See the [monitoring setup guide](./setup-monitoring.md).
5. The bot needs `EGMA_URL` and `EGMA_API_KEY` wherever it runs. Create a project key with `egma project api-key create --name "<bot name>"`; it is printed once. Use `EGMA_URL=https://api.egma.ai` unless the developer uses a self-hosted egma (then its API URL). For this machine, put both in the bot's gitignored `.env`. Never commit the key and never print it in your messages.
6. If the bot reads startup data from `runner_args.body` (tenant, locale, caller data), note the keys. Tests pass them in `pipecat_body_params` (see the `/write-voice-agent-tests` skill).

## 3. Add the connections

Default to creating both a voice and a chat connection for every way you connect.

1. This machine (always, for the first run) - `egma agent dev` creates this machine's voice and chat connections on its first start. You do not add them by hand. See step 4.
2. Pipecat Cloud (when `pcc-deploy.toml` exists) - use the public key the repo or the developer already uses. Only if there is none, ask the developer for one, or create one with `pipecat cloud organizations keys create` when you are allowed to. Supply it through `EGMA_PIPECAT_PUBLIC_KEY` or `--credentials-stdin` with `{"publicApiKey":"pk_..."}`, never as a command-line argument.

```bash
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-cloud --modality voice --pipecat-agent-name "<agent_name from pcc-deploy.toml>"
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-cloud --modality chat --pipecat-agent-name "<agent_name from pcc-deploy.toml>"
```

3. Self-hosted (when the team runs its own starter) - the start URL must be public HTTPS. The starter must accept pipecat's start request shape (`createDailyRoom`, `dailyRoomProperties`, `body`, `transport: "daily"`) and answer `{"dailyRoom": "https://…daily.co/…", "dailyToken": "…"}`. Supply the auth headers as a JSON object through `EGMA_PIPECAT_START_HEADERS` or `--credentials-stdin` with `{"headers":{…}}`.

```bash
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-self-hosted --modality voice --pipecat-start-url "<https start URL>"
```

Use `egma agent connection add --help` and `egma agent connection options --platform pipecat` if anything is unclear.

## 4. Run the first suite on this machine, then hand over the deploy

Before any deploy, prove the setup against the bot on this machine:

1. Check that `cloudflared` is installed (`brew install cloudflared` on macOS). Check that the bot's environment has `DAILY_API_KEY` (pipecat's development runner creates a Daily room per start request with it) and that `DAILY_ROOM_URL` is unset (otherwise every simulation shares one room). Ask the developer for a Daily key only if none is available.
2. Start the bot with pipecat's development runner as a background process, for example `uv run bot.py -t daily`. It listens on port 7860 unless the bot sets another.
3. Start `egma agent dev --agent "$EGMA_AGENT_ID" --port 7860` as a second background process. It is long-running; keep it running for the whole run. The first start creates the `dev-<computer name>-voice` and `dev-<computer name>-chat` connections.
4. Run `egma pull` and read the two connection IDs from `egma/config.yaml`. Run the suite against the voice connection (see the simulation testing guide).
5. If a simulation fails, read its reason with `egma run get`. The messages name the cause and the fix; the full list is at https://docs.egma.ai/docs/integrations/pipecat/troubleshooting.
6. After the suite finishes, stop `egma agent dev` and the bot. The connections stay and work again the next time `egma agent dev` runs.

Then hand over the deploy step to the developer, or run it only when you were explicitly allowed to deploy:
- Pipecat Cloud: add `EGMA_URL` and `EGMA_API_KEY` to the secret set named in `pcc-deploy.toml` (`pipecat cloud secrets set <secret_set> EGMA_URL=... EGMA_API_KEY=...`), recommend `min_agents = 1` under `[scaling]` in `pcc-deploy.toml` so a cold start does not fail simulations (it costs a warm instance), and redeploy (for example `pipecat cloud deploy`). Then run the suite against the Pipecat Cloud voice connection.
- Self-hosted: deploy the SDK change and the two environment values to the servers that run the bot, then run the suite against the self-hosted connection.

Tell the developer that simulations against a deployed bot only work after this deploy.
