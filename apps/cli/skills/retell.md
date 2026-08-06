---
name: retell-voice-agents
description: What a Retell voice agent looks like from inside a repository — the SDK, dashboard-managed against repository-managed prompts, and where the identifiers are written down.
---

# Retell voice agents, as a repository shows them

Retell hosts voice agents and puts them behind a phone number or a web widget.
The fact that matters most when you read a repository: **much of what steers a
Retell voice agent lives on Retell's side, not in the files in front of you.**
A repository can look nearly empty and still have a complete voice agent behind
it. Report where the steering lives, whatever the answer is.

## The signs

**In the manifest.** `retell-sdk` in `package.json`; `retell-sdk` in
`pyproject.toml` or `requirements.txt` — Retell publishes both under that one
name.

**In the source.**

```ts
import Retell from "retell-sdk";
const retell = new Retell({ apiKey: process.env.RETELL_API_KEY });
```

```python
from retell import Retell
client = Retell(api_key=os.environ["RETELL_API_KEY"])
```

**Around the edges.** `RETELL_API_KEY` named in a Dockerfile, a workflow file or
the README. A webhook route that Retell posts events to. A `wss://` endpoint the
repository serves. (Files named `.env…` are fenced off from you, so read the
names out of the code and the committed configuration instead.)

## Two halves, and why it matters

Retell splits a voice agent in two:

- **the agent** — voice, language, telephony, webhook endpoints. Its identifier
  starts with `agent_`.
- **the response engine** — the words and the tools. Its shape is the fork you
  are looking for:

| `response_engine` | What it means | What to report as `prompts` |
|---|---|---|
| `{ type: "retell-llm", llm_id: "llm_…" }` | The prompt is a Retell LLM object, normally edited in the Retell dashboard | `managed in the Retell dashboard (llm_…)`, plus the file the id sits in |
| `{ type: "custom-llm", llm_websocket_url: "wss://…" }` | The repository runs the model itself and Retell streams to it | the file in the repository that builds the system prompt |

There is a third, and it is the one worth looking hardest for: a repository
that keeps its prompt in a file **and pushes it to Retell**. It shows up as a
deploy script reading a prompt file and handing it to the SDK:

```ts
await retell.llm.update(LLM_ID, {
  general_prompt: await readFile("prompts/greeter.md", "utf8"),
});
```

When you see that, both answers are true: report the repository file as
`prompts`, and name the script under `deploy`.

## Where the identifiers live

`agent_` and `llm_` identifiers are long hexadecimal strings. Look in
`src/config.*`, `config.json`, `retell.json`, a constant beside the SDK client,
or a workflow file's environment block. Report the **file** in `agent-id`, not
the identifier itself.

## Where the tools live

On a Retell LLM the tools sit in `general_tools`, and in a multi-state agent
each state carries its own set beside a `state_prompt`. Retell ships some tools
of its own; the ones a repository defines are custom tools that name a `url`,
and that url points at a route this repository serves. Those routes — often
under `src/tools/`, `api/`, or a router file — are the tool definitions to
report.

## How it reaches production

Common shapes, in the order you will meet them:

1. A script (`scripts/deploy.*`, an npm script, a CI workflow) that creates or
   updates the agent and the LLM through the SDK.
2. A web service the repository deploys — the tool routes, the webhook
   endpoint, or a custom-LLM websocket server — with the agent itself created
   once by hand in the dashboard.
3. Nothing at all in the repository, because everything was done in the
   dashboard. That is a real answer: report `deploy` as
   `Retell-hosted, configured in the Retell dashboard`.

## What a good report looks like

```
egma:found framework retell-sdk
egma:found prompts prompts/greeter.md (pushed to Retell by scripts/deploy.ts)
egma:found tools src/tools/*.ts (2 definitions, registered as Retell custom tools)
egma:found deploy Retell-hosted; scripts/deploy.ts updates the agent
egma:found agent-id src/config.ts
```
