<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/dark.svg">
    <img alt="Egma" src="docs/logo/light.svg" width="180">
  </picture>
</p>

<p align="center"><strong>Trust the voice agents you ship in production through monitoring, self-improvement and simulation testing.</strong></p>

<p align="center">
  <a href="https://docs.egma.ai">Docs</a> ·
  <a href="https://docs.egma.ai/quickstart">Quickstart</a> ·
  <a href="https://docs.egma.ai/self-hosting">Self-host</a> ·
  <a href="https://app.egma.ai">Egma Cloud</a> ·
  <a href="https://discord.gg/TODO">Discord</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/github/license/egma-ai/egma"></a>
  <a href="https://github.com/egma-ai/egma/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/egma-ai/egma/actions/workflows/test.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/@egma/cli"><img alt="@egma/cli on npm" src="https://img.shields.io/npm/v/%40egma%2Fcli?label=%40egma%2Fcli"></a>
  <a href="https://www.npmjs.com/package/@egma/livekit"><img alt="@egma/livekit on npm" src="https://img.shields.io/npm/v/%40egma%2Flivekit?label=%40egma%2Flivekit"></a>
  <a href="https://pypi.org/project/egma/"><img alt="egma on PyPI" src="https://img.shields.io/pypi/v/egma?label=egma%20on%20PyPI"></a>
  <a href="https://deepwiki.com/egma-ai/egma"><img alt="Ask DeepWiki" src="https://deepwiki.com/badge.svg"></a>
</p>

<!-- TODO: add one screenshot of a run page here: transcript, metrics, and grades. -->

Egma is the open-source platform for teams that need evidence they can trust
before and after a voice agent reaches production. It runs real conversations
against your agent from tests that live in your repository, receives the
conversations your agent has in production, and grades both with the same
graders.

## What Egma does

A voice agent's behavior comes from the whole conversation: the prompt, the
model, the speech stack, the tools, the systems behind them, and the person on
the line. A unit test cannot prove that path. Egma puts your agent under
pressure, records exactly what it did, and tells you whether that was what you
expected.

- **Simulation testing.** A test is a Markdown file: one situation, the
  personas who call about it, and the behaviors you expect. Egma runs one real
  conversation per test and persona, in text or over voice, and keeps the
  transcript, the timings, the tool calls, and, for voice, the recording.
- **Production monitoring.** Egma receives your real conversations. Retell
  calls are pulled through Retell's API. LiveKit workers push OpenTelemetry
  spans through the Egma SDK. Any other instrumented process can send standard
  OTLP.
- **Grading.** Graders read the evidence and return a normalized score. The
  same graders run on simulations and on production conversations, so a
  failure you notice in production becomes a check on every future run.

## How it works

| Word | Meaning |
|---|---|
| **Test** | One situation, its personas, and the expected behaviors. A Markdown file in your repository. |
| **Test suite** | The tests you review and run together. A directory. |
| **Run** | One complete suite against one agent over one connection. |
| **Simulation** | One test and one persona, run once, inside a run. |
| **Persona** | The synthetic caller: manner, patience, and voice. Egma provides one, and a project can create its own. |
| **Grader** | Logic that reads a completed conversation and returns a score from 0 to 1. |

```text
your repository              Egma                                     your agent
egma/tests/*.md ── push ──▶  simulator ── one conversation per test and persona ──▶  Retell, LiveKit, or a phone number
                             trace store ◀── transcript, spans, metrics, recording
                             grader ──── one score per grader, per completed conversation
production calls ── pull or push ──▶  the same trace store, the same graders
```

## Quickstart

You need Node.js 22 or newer, an account on [Egma Cloud](https://app.egma.ai)
or a [self-hosted instance](#self-hosting), and a voice agent on Retell or
LiveKit.

Sign in from the repository that contains your agent. Egma opens a
device-approval page in your browser.

```bash
npx --yes @egma/cli login
```

Register the agent and one way to reach it. This example connects a Retell
agent in text mode, which places no call and runs with mock tools on. The docs
cover [web-call and phone lanes](https://docs.egma.ai/integrations/retell) and
[LiveKit rooms](https://docs.egma.ai/quickstart).

```bash
EGMA_RETELL_API_KEY=key_live_... npx --yes @egma/cli connect \
  --platform retell \
  --retell-agent agent_... \
  --lanes text
```

List the personas you can use, then create a suite. The suite is created on
Egma and its manifest is written to `egma/tests/receptionist-core/suite.yaml`.

```bash
npx --yes @egma/cli personas
npx --yes @egma/cli suite create receptionist-core --name "Receptionist core"
```

Write a test as `egma/tests/receptionist-core/missed-appointment.md`. Use a
persona name from the list you just printed.

````markdown
---
format: 4
name: missed-appointment-reschedule
personas:
  - name: Everyday caller
---

## Scenario

The caller missed yesterday's appointment and wants another one this week.
They are short of time and already annoyed.

## Expected behaviors

1. The agent acknowledges the missed appointment without blaming anyone.
2. The agent offers at least two other times.
3. The agent repeats the new time before it ends the call.

## Mock tools

### check_availability
```json
{ "answer": { "slots": ["Wednesday 15:00", "Thursday 11:00"] } }
```
````

Validate, publish, and run. The run command follows the run until every
simulation and its grading finish, and prints the address of the results.

```bash
npx --yes @egma/cli validate
npx --yes @egma/cli push
npx --yes @egma/cli run receptionist-core
```

Prefer to hand the setup to your coding agent? Run the bare
`npx --yes @egma/cli` in the agent's repository and paste the printed handoff
into the agent. The [Quickstart](https://docs.egma.ai/quickstart) walks that
path end to end.

## What you get

**Connections.** One agent can have several ways to reach it, and every run
records which one it used.

| Platform | Path | Modality | Mock tools |
|---|---|---|---|
| Retell | Text mode | chat | On by default. Answers ride on each request. |
| Retell | Web call | voice | Optional. Egma places the call over the internet. |
| Any | Phone number | voice | Never. The call reaches your real tools over a carrier. |
| LiveKit | Room with project credentials | chat or voice | Through the Egma SDK in your worker. |
| LiveKit | Room with your token endpoint | voice | Through the Egma SDK in your worker. |

**Mock tools.** A simulation that reaches your real tools has real side
effects, and a real backend only shows the branch its data is on. A mock tool
answers for one of your agent's tools during a simulation, matched by name,
with a value, an error, or either one after a delay. Project-wide answers live
in `egma/mock-tools.md`. A test overrides them to force one branch, such as an
empty calendar. Tools without a mock run for real, and the simulation's record
shows which calls Egma answered.

**Production monitoring.** Turn on **pull production calls** on a Retell agent,
or add one line to a LiveKit worker. Every production conversation shows up as
a transcript with per-turn timings and tool evidence, and the graders whose
scope selects production grade it.

**Graders.** Egma ships **Expected behaviors**, a model judge that checks each
behavior in the test against the transcript, and **Response latency**, a code
grader that holds the p90 turn response time under a limit you choose. You can
write your own LLM graders from instructions, a passes-when, and a fails-when.
Every grader keeps its own pass threshold, and every grade freezes the exact
definition version it used.

**Metrics.** First response latency, per-turn response latency, time to first
word, speech recognition, model, and speech synthesis latency, speech
durations, and turn count. They are computed the same way for a simulation and
a production call.

**Recordings.** Voice simulations keep a recording next to the transcript.

**An API and a CLI.** The REST API covers projects, agents, connections,
suites, tests, runs, graders, monitoring, and traces, and is described by an
OpenAPI document. The CLI asks no questions and prints one fact per line, so it
runs in CI.

## Self-hosting

Self-hosting gets you the whole product. Nothing is held back for the hosted
version. One command starts the API, the web application, the simulator, the
grader, Postgres, ClickHouse, MinIO, LiveKit, a SIP gateway, and Redis.

You need Node.js 22 or newer, Docker with Compose, and API keys for the model
providers your personas and graders use. The shipped persona uses OpenAI and
Cartesia.

```bash
git clone https://github.com/egma-ai/egma.git
cd egma
cp .env.example .env      # add EGMA_OPENAI_API_KEY and EGMA_CARTESIA_API_KEY
npx @egma/cli self-host up
```

Open `http://localhost:3101` and sign up. The first person becomes the admin
of the instance. The [self-hosting guide](https://docs.egma.ai/self-hosting)
covers phone simulations over your own SIP trunk, service addresses, upgrades,
and troubleshooting.

## Egma Cloud

[Egma Cloud](https://app.egma.ai) runs the same code as this repository. Sign
up there, then run `egma login` from your repository.

## Packages

| Package | Registry | What it does |
|---|---|---|
| [`@egma/cli`](https://www.npmjs.com/package/@egma/cli) | npm | The `egma` command: sign in, connect an agent, keep tests in step, run suites, manage monitoring, and self-host. |
| [`@egma/livekit`](https://www.npmjs.com/package/@egma/livekit) | npm | For LiveKit Agents JS workers: `mockable` for simulations and `monitorLiveKit` for production. |
| [`egma`](https://pypi.org/project/egma/) | PyPI | For LiveKit Agents Python workers: `mockable` for simulations and `monitor_livekit` for production. |

Both SDKs decide everything from the room's name. In a room Egma named for a
simulation, they report the agent's tools and let Egma answer the mocked ones.
In every other room, `mockable` does nothing, and in a simulation room the
monitoring hook does nothing. So a mocked answer never reaches production, and
a simulation never appears in Monitoring.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | The Fastify API. It applies migrations on boot, then serves the REST API and OTLP ingest. |
| `apps/web` | The Next.js web application. |
| `apps/simulator` | The Python service that conducts simulations: the persona, the speech legs, and one plug per connection type. |
| `apps/grader` | The service that grades completed traces from a frozen plan. |
| `apps/cli` | The `egma` command. |
| `sdks/python`, `sdks/livekit-js` | The SDKs a customer installs in a LiveKit worker. |
| `packages/db` | The data-access module: schema, migrations, and every read and write. |
| `packages/platform-api` | The executable `/v1` contract, its OpenAPI document, and the generated client. |
| `packages/simulation-contract` | The versioned JSON contract between the control plane and the simulator. |
| `packages/metrics` | The measure catalog and the code that computes metrics from spans. |
| `packages/ids`, `packages/lint`, `packages/provider-credentials`, `packages/retell` | Identifiers, build-time boundary rules, sealed provider credentials, and the Retell client. |
| `docs` | The source of [docs.egma.ai](https://docs.egma.ai). |
| `fixtures` | Checked-in captures used as test inputs. |

## Developing

Contributing needs Node.js 24, pnpm 10, [uv](https://docs.astral.sh/uv/) for
the two Python packages, Docker for the test databases, and Google Chrome or a
Chromium for the one real-browser test.

```bash
pnpm install
pnpm db:up          # Postgres and ClickHouse for the tests
pnpm test:fast      # the loop you work in: no browser, no web application
pnpm test           # everything: both lanes, then the simulator, SDK, and fixture suites
pnpm lint
pnpm typecheck
pnpm db:down
```

Tests run against a real Postgres and a real ClickHouse. Each test file creates
its own database and drops it afterwards, so a fresh checkout needs no `.env`.
Every pull request runs the fast lane in CI. A pull request into `main` runs
everything.

## Community

- Ask questions and share what you are building on [Discord](https://discord.gg/TODO).
- Report bugs and request features in [GitHub Issues](https://github.com/egma-ai/egma/issues).
- Ask the codebase itself on [DeepWiki](https://deepwiki.com/egma-ai/egma).

## License

Egma is licensed under the [Apache License, Version 2.0](LICENSE).
