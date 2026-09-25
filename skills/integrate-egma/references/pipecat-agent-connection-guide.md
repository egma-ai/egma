# Connecting to a pipecat agent

This guide sets up a Pipecat bot for simulation testing, production monitoring, or both. The developer usually starts it with a prompt copied from the egma web app. That prompt names the goal, the egma URL and the project, and sometimes an existing egma agent (`Agent: <name> (<agent ID>)`). Use those facts and do not ask for them again.

## Important concepts to know first

A. How egma reaches a pipecat bot
  - A pipecat bot has no dispatch. For each simulation egma sends one start request to a starter. The starter creates a Daily room, starts the bot in it with `runner_args.body` = the request's `body`, and answers with the room URL. egma's persona joins that room. Only the Daily transport is supported, so the bot must build a `DailyTransport` for `DailyRunnerArguments`, as the pipecat quickstart does.
  - There are three places a bot can run for simulations. Each is its own path below, and none of them needs another first:
    1. This machine - `egma agent dev` opens a Cloudflare quick tunnel to pipecat's development runner on this computer and creates this machine's voice and chat self-hosted connections. No deploy.
    2. Pipecat Cloud - egma sends the start request to Pipecat Cloud with the Pipecat Cloud agent name and a public API key (starts with `pk_`). Never use or ask for a private key (`sk_`).
    3. The team's own servers - egma sends the start request to the team's public HTTPS start URL with auth headers.

B. Modalities
  1. Voice - runs a full voice simulation through the bot's STT, LLM and TTS.
  2. Chat - the persona sends text through RTVI. It needs no code beyond the SDK line: in a chat simulation the SDK turns the bot's speech output off by itself. It needs RTVI, which `PipelineWorker` turns on by default. If the bot passes `enable_rtvi=False`, or `rtvi_observer_params` with `bot_llm_enabled=False`, chat simulations fail; tell the developer.
  Create a voice and a chat connection for every path.

C. Keys
  - Every place the bot runs needs `EGMA_URL` and `EGMA_API_KEY`. The key is an egma project API key, and you can make as many as you need with `egma project api-key create --name "<name>"`.
  - Give each place its own key: one per computer (for example `--name "namans-macbook-pro dev"`) and one for production (for example `--name "<agent name> production"`). Never copy a key from one place to another.
  - The CLI prints a new key once. Send that output to a file, not to your own messages: for example `egma project api-key create --name "<name>" > <temporary file>`, then take the key from the file into its destination and delete the file. Never print a key, never commit one, and never read a value out of an environment file. Check a variable only by its name, for example `grep -c '^DAILY_API_KEY=' .env`.
  - Production monitoring also needs `EGMA_AGENT_NAME`: the agent's name in egma, as `egma/config.yaml` lists it. The SDK sends it with each production conversation, so Monitoring shows which agent took the call.

D. Ask before production changes
  Ask the developer before you change a Pipecat Cloud secret set, the team's server settings, or deploy anything. A deploy replaces the code that takes real calls.

## 1. Get ready

1. Check `egma --version`. Pipecat needs egma-cli 0.8.0 or later. If it is older, run `npm install --global egma-cli@latest`.
2. If the prompt's egma URL is not `https://app.egma.ai`, pass it to the CLI: `egma login --url <egma URL>` and `egma init --url <egma URL> ...`.
3. Make sure the `egma/` folder exists and is in sync (`egma init --project <project ID>` if it is missing, else `egma pull`).
4. If the prompt names an agent ID, use that agent. Otherwise check `egma/config.yaml` for this bot's agent, and if there is none, register one with `egma agent register --platform pipecat --name "<name>"`.

## 2. Ask where the bot runs

- For simulations, ask: "Where should Egma run the simulations: on this machine, on Pipecat Cloud, or on your own servers?"
- For monitoring, ask: "Where does the bot run in production: on Pipecat Cloud, on your own servers, or not deployed yet?"
- For both, ask both questions in one message.
- Suggest an answer from the repo: a `pcc-deploy.toml` means Pipecat Cloud (its `agent_name` is the Pipecat Cloud agent name, and `secret_set` is the secret set that holds the bot's environment); an HTTP route that creates Daily rooms and starts `bot()` means the team's own servers; neither means this machine.

## 3. Add the egma SDK to the bot

1. Install `egma[pipecat]` with the package manager the repo already uses (for example `uv add "egma[pipecat]"`). The SDK supports Python 3.11+ and `pipecat-ai>=1.9,<1.12`. If the repo pins pipecat-ai outside that range, stop and tell the developer. The `pipecat` extra installs no livekit package.
2. Find where the bot creates its `PipelineWorker(...)` and where it calls `runner.add_workers(worker)`. Add the lines between the two. `runner_args` is the argument of `bot(runner_args)`. If the worker is built in a helper, such as the quickstart's `run_bot(transport)`, add a `runner_args` parameter to it and pass it from `bot()`.

```python
from egma.pipecat import monitor, simulation

async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    ...
    worker = PipelineWorker(pipeline, params=PipelineParams(...))

    await simulation(worker, runner_args)  # simulation testing
    await monitor(worker, runner_args)  # production monitoring

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def bot(runner_args: RunnerArguments):
    ...
    await run_bot(transport, runner_args)
```

3. Add `simulation` for simulation testing and `monitor` for monitoring; for both, add both lines, `simulation` first. Make both code changes in one pass, so one deploy carries both.
4. `simulation` is inert in production: without an `egma` key in `runner_args.body` it makes no network request. It raises `NotReported` when it cannot report to egma, and the bot does not start. Do not catch it. Do not add code that reads or strips the `egma` key; the SDK owns it.
   - Egma does not mock Pipecat Flows functions (from `pipecat.flows`). A simulation whose test mocks one fails when the flow first offers that function. Flows functions that are not mocked run for real and are recorded, so Flows bots can be tested; never mock their functions.
5. `monitor` never stops the bot: without `EGMA_URL` or `EGMA_API_KEY` it logs a warning and sends nothing. It stays silent only in a simulation that `simulation` reported, so keep `simulation` before it.
6. If the bot reads startup data from `runner_args.body` (tenant, locale, caller data), note the keys. Tests pass them in `pipecat_body_params` (see the `/write-voice-agent-tests` skill).

## 4. Follow the path for each place

### Path A: this machine (no deploy)

1. Keys: create a project key for this computer and put `EGMA_URL` and `EGMA_API_KEY` in the bot's gitignored `.env` (see C). Use the egma URL from the prompt, else `https://app.egma.ai`.
2. Check that `.env` has `DAILY_API_KEY` (pipecat's development runner creates a Daily room per start request with it) and the provider keys the bot reads, by name only. Check that `DAILY_ROOM_URL` is unset (otherwise every simulation shares one room). On Pipecat Cloud teams, `pipecat cloud auth whoami` shows the organization's Daily API key. Ask the developer for anything missing.
3. Check that `cloudflared` is installed (`brew install cloudflared` on macOS). Ask before you install it.
4. Start the bot with pipecat's development runner as a background process, for example `uv run bot.py -t daily`. It listens on port 7860 unless the bot sets another.
5. Start `egma agent dev --agent "$EGMA_AGENT_ID" --port 7860` as a second background process. It is long-running; keep it running for the whole run. The first start creates the `dev-<computer name>-voice` and `dev-<computer name>-chat` connections, and every start prints their names and IDs.
6. Write tests and run them against the voice connection (see the simulation testing guide).
7. Tell the developer that these connections work only while this computer runs both processes, so CI needs Pipecat Cloud or the team's own servers.

### Path B: Pipecat Cloud

1. Sign in to Pipecat Cloud if needed (`pipecat cloud auth whoami`, else `pipecat cloud auth login`; the developer approves it in the browser).
2. Before the deploy, run the repo's checks and import the bot once (for example `uv run python -c "import bot"`), so a broken import never reaches the bot that takes real calls.
3. Public key: use the one the repo or the developer already uses. If there is none, ask, then create one with `pipecat cloud organizations keys create`. Supply it through `EGMA_PIPECAT_PUBLIC_KEY` or `--credentials-stdin` with `{"publicApiKey":"pk_..."}`, never as a command-line argument.

```bash
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-cloud --modality voice --pipecat-agent-name "<agent_name from pcc-deploy.toml>"
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-cloud --modality chat --pipecat-agent-name "<agent_name from pcc-deploy.toml>"
```

4. Ask the developer, then add `EGMA_URL`, a production project key as `EGMA_API_KEY` and, for monitoring, `EGMA_AGENT_NAME` to the secret set named in `pcc-deploy.toml`. Write them to a temporary file and run `pipecat cloud secrets set <secret_set> --file <temporary file>`, which adds or replaces only those names; then delete the file. Check the names with `pipecat cloud secrets list <secret_set>`. `EGMA_URL` must be a public URL that Pipecat Cloud can reach.
5. Ask the developer, then deploy (for example `pipecat cloud deploy`). A secret change alone does not reach running instances.
6. For simulations, write tests and run them against the Pipecat Cloud voice connection. A cold start adds a few seconds. Suggest `min_agents = 1` under `[scaling]` in `pcc-deploy.toml` only if simulations fail because the bot starts too slowly; it costs a warm instance.

### Path C: the team's own servers

1. The start URL must be public HTTPS. The starter must accept pipecat's start request shape (`createDailyRoom`, `dailyRoomProperties`, `body`, `transport: "daily"`) and answer `{"dailyRoom": "https://…daily.co/…", "dailyToken": "…"}`. If it does not, tell the developer what to change before you go on.
2. Ask the developer for the start URL and the auth headers. Supply the headers as a JSON object through `EGMA_PIPECAT_START_HEADERS` or `--credentials-stdin` with `{"headers":{…}}`.

```bash
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-self-hosted --modality voice --pipecat-start-url "<https start URL>"
egma agent connection add --agent "$EGMA_AGENT_ID" --access pipecat-self-hosted --modality chat --pipecat-start-url "<https start URL>"
```

3. The servers need `EGMA_URL`, a production project key as `EGMA_API_KEY` and, for monitoring, `EGMA_AGENT_NAME`. If the deploy settings are in the repo, ask before you change them; otherwise give the developer the three names and where each value comes from.
4. After the developer deploys, run the tests against the self-hosted voice connection.

### Monitoring when the bot is not deployed yet

Put the three values in `.env` (a key for this computer, and `EGMA_AGENT_NAME`), start the bot with the development runner, and ask the developer to talk to it once at `http://localhost:7860/daily`. The conversation appears under **Monitoring** with the agent's name. Then tell the developer the three values to set where the bot will run in production.

## 5. Run the tests again later

- A `dev-` connection works only while this computer runs the bot and `egma agent dev`. Start both again before a run. `egma agent dev` writes its new tunnel URL into the same two connections.
- A Pipecat Cloud or self-hosted connection tests the code that is deployed, not local changes. To test a change before a deploy, run it on this machine.
- If a simulation fails, read its reason with `egma run get`. The messages name the cause and the fix; the full list is at https://docs.egma.ai/docs/integrations/pipecat/troubleshooting.

Use `egma agent connection add --help` and `egma agent connection options --platform pipecat` if anything is unclear.
