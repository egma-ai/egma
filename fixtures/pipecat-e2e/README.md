# The Pipecat test bot

A real Pipecat bot for Egma to simulate against, shaped like the bot that
`pipecat init` generates: Daily transport, Deepgram speech recognition, OpenAI
`gpt-4.1` through the Responses API, Cartesia speech, RTVI on, a greeting when
the client sends RTVI `client-ready`, and a stop when the client leaves. It is
the phone assistant of a hardware shop, so a simulation has tools to call.

The proofs of Egma's Pipecat support run against this bot on Pipecat Cloud,
behind a self-hosted start URL, and on this machine through `egma agent dev`.
None of it runs in CI.

## What is in it

| File | What it does |
| --- | --- |
| `bot.py` | The bot. `bot(runner_args)` is the entry point Pipecat Cloud and the development runner call. The Egma SDK line sits between `PipelineWorker(...)` and `runner.add_workers(worker)`. |
| `store.py` | The shop: fixed answers, no clock, no network. Every real tool run logs one `E2E_REAL_TOOL` line. |
| `flow.yaml`, `flow_handlers.py` | The Pipecat Flows variant: a declarative flow, as in Pipecat's Flows quickstart. |
| `tools/rtvi_client.py` | An RTVI client: sends a start request, joins the Daily room, sends `client-ready`, types with `send-text` (`--say`) or speaks through a virtual microphone (`--speak`, needs `OPENAI_API_KEY`), and times every event. |
| `tools/starter.py` | A customer-style starter: its own `POST /start` behind an `Authorization` header, a separate non-owner token for the client. |
| `Dockerfile`, `pcc-deploy.toml`, `deploy.sh` | The Pipecat Cloud deployment. |

### The tools

| Variant | Tool | Registered as | Meant for |
| --- | --- | --- | --- |
| plain | `lookup_order(order_id)` | `llm.register_function` plus a `FunctionSchema` in the context | a mock tool in a test |
| plain | `check_store_hours(day)` | a direct function in the context's `ToolsSchema` | running for real |
| flows | `check_store_hours(day)` | a Flows node function | running for real |
| flows | `begin_return(item)` | a Flows edge function, `transition_to: returns` | running for real |
| flows | `record_return(order_id, reason)` | a Flows edge function, `transition_to: wrap_up` | the "Flows function cannot be mocked" test |

Orders `A100`, `B200` and `C300` exist; every other order id is not found.

### Choosing the bot's shape per session

Each session reads `runner_args.body["e2e"]`, so a test picks the shape in its
`pipecat_body_params`. Environment variables set the defaults.

| Key | Values | Environment | Default |
| --- | --- | --- | --- |
| `variant` | `plain`, `flows` | `E2E_VARIANT` | `plain` |
| `rtvi` | `on`, `off` | `E2E_RTVI` | `on` |
| `sdk` | `auto`, `on`, `off` | `EGMA_SDK` | `auto` (use `egma.pipecat` when it is installed) |
| `monitor` | `on`, `off` | `EGMA_MONITOR` | `off` |
| `skip_tts` | `on`, `off` | `E2E_SKIP_TTS` | `off` |

`sdk: off` is the bot without the SDK. `rtvi: off` turns RTVI off in the
pipeline; the bot then greets when the client connects. `skip_tts: on` silences
every reply from the start of the session, as the Egma SDK does in a chat
simulation.

For example, a test's env block for the Flows variant:

```json
{ "pipecat_body_params": { "e2e": { "variant": "flows" } } }
```

## Run it on this machine

Needs Python 3.11 or later, [uv](https://docs.astral.sh/uv/), and the keys in
`.env.example`. Copy that file to `.env` beside `bot.py` and fill it in; the
development runner needs `DAILY_API_KEY` to create a Daily room per start
request.

```sh
cd fixtures/pipecat-e2e
uv sync
uv run bot.py -t daily          # Pipecat's development runner on http://localhost:7860
```

Start a session and talk to it by text:

```sh
uv run tools/rtvi_client.py url --start-url http://localhost:7860/start \
  --body '{"egma": {"simulation_id": "sim_local"}}' \
  --say "When are you open on Saturday?" --say "Can you check order A100?"
```

The runner answers `POST /start` with `{"dailyRoom", "dailyToken", "sessionId"}`,
the same shape as Pipecat Cloud's start API, when the request carries
`"transport": "daily"` and `"createDailyRoom": true`.

To stand in for a team's own server instead of Pipecat's runner, run the
starter. It refuses a request without `Authorization: Bearer <STARTER_SECRET>`:

```sh
STARTER_SECRET=... uv run tools/starter.py --port 7870
uv run tools/rtvi_client.py url --start-url http://localhost:7870/start \
  --header "Authorization: Bearer $STARTER_SECRET"
```

## Run it on Pipecat Cloud

Log the Pipecat CLI in (`pipecat cloud auth login`), then create the secret set
once with the bot's keys (and, for runs with the SDK, `EGMA_URL` and
`EGMA_API_KEY`):

```sh
pipecat cloud secrets set egma-e2e-secrets --file .env
```

Deploy with a cloud build:

```sh
./deploy.sh                    # with the Egma SDK built from sdks/python
EGMA_SDK_WHEEL=off ./deploy.sh # without the SDK
./deploy.sh --min-agents 0     # extra arguments go to pipecat cloud deploy
```

`deploy.sh` stages a clean build context in `.build/` (the bot's files and the
SDK wheel), so nothing else from the repository is uploaded. `pcc-deploy.toml`
keeps one instance warm (`min_agents = 1`). A new secret value alone does not
replace warm instances; redeploy with `--force` after changing one.

Start a session through the public start API with the organization's public
key (`pk_…`) in `EGMA_PIPECAT_PUBLIC_KEY`:

```sh
uv run tools/rtvi_client.py pcc --agent egma-e2e --body '{"egma": {"simulation_id": "sim_test"}}'
```

Read the bot's logs with `pipecat cloud agent logs egma-e2e`.
