---
name: finding-the-voice-agent
description: Find the voice agent in a repository nobody has described to you — its framework, its prompts, its tools and how it reaches production — and report the facts as Egma marker lines.
---

# Find the voice agent in this repository

Egma is driving you. Somewhere in the folder you were started in there is a
**voice agent**: a program that speaks with a person and does something for
them. Egma needs a few facts about it before it can test it.

Read the repository. Report facts. Change nothing.

## The facts Egma needs

<!-- The names in this table are FACTS in src/wizard/facts.ts, which is the source of truth; keep the two in step. -->

| Fact | What it means |
|---|---|
| `framework` | The library or platform that runs the voice agent |
| `prompts` | Where the words that steer the voice agent live |
| `tools` | Where the actions the voice agent can take are defined |
| `deploy` | How the voice agent reaches production |
| `agent-id` | Where an identifier for the voice agent is written down, if there is one |

## How to report: marker lines

Put each fact on a line of its own, at the very start of the line, with no
bullet, no number and no code fence around it:

```
egma:found framework retell-sdk
egma:found prompts prompts/greeter.md
egma:found tools src/tools/ (2 definitions)
egma:found deploy Retell-hosted, updated by scripts/deploy.ts
egma:found agent-id src/config.ts
```

Three more markers exist:

```
egma:note Reading package.json
egma:none There is no voice agent in this folder.
egma:abort I cannot read this repository.
```

`egma:note` is one short line about what you are doing right now. Use
`egma:none` when you have looked properly and there is no voice agent here —
never guess one into existence. Use `egma:abort` only when something stops you
outright; Egma itself ends the work when it reads that line.

Everything else you write goes to a log file the developer can open. Only
marker lines reach the screen, so a fact that is not in a marker line is a fact
Egma does not have.

**End every marker line with a line break, and never put ordinary words on the
same line as a marker.** Write the `egma:found` lines as one block, last, with
nothing after them.

## Where to look, in this order

1. **The manifest.** `package.json`, `pyproject.toml`, `requirements.txt`,
   `go.mod`, `Cargo.toml`. Its dependency list names the framework faster than
   any amount of reading.
2. **The entry point the manifest names** — `main`, `scripts.start`, a
   `Dockerfile` command, a `Procfile`.
3. **Prompt-shaped files.** A `prompts/` folder, `prompt.*`, `*.prompt.*`,
   `instructions.*`, `system*.md`, a `.txt` full of prose — or a long string
   constant in the source itself.
4. **Tool-shaped files.** A `tools/` or `functions/` folder, a list of tool
   definitions handed to the framework, a declared MCP server, HTTP routes the
   platform posts to.
5. **Deploy-shaped files.** `Dockerfile`, `fly.toml`, `render.yaml`,
   `serverless.yml`, `.github/workflows/`, `scripts/deploy.*`, a `Makefile`.

## Frameworks to recognise

| In the manifest | Report as `framework` | Where the prompt usually sits |
|---|---|---|
| `retell-sdk` | `retell-sdk` | Often in the Retell dashboard rather than the repository — read the Retell skill |
| `@vapi-ai/server-sdk`, `@vapi-ai/web`, `vapi_python` | `vapi` | An assistant object in the source, or in the Vapi dashboard |
| `livekit-agents`, `@livekit/agents` | `livekit-agents` | The instructions given to the agent in the worker file |
| `pipecat-ai` | `pipecat` | The first system message of the context handed to the pipeline |

If the manifest names none of these, the voice agent may sit straight on a
model provider's realtime API or on a telephony library. Report the library you
actually see rather than forcing it into this table.

## Rules

- **Read only.** Do not write, move or delete anything. Do not run a command
  that changes the repository, installs a package, or reaches the network.
- **Report paths as the repository holds them**, relative to the folder you
  were started in. A glob such as `src/tools/*.ts` is a good value when several
  files share a job.
- **One fact per marker line.** The first word after `egma:found` is the fact's
  name; the rest of the line is its value.
- **Never invent.** If the prompts are not in the repository, say where they are
  instead — `managed in the Retell dashboard` is a good `prompts` value — or
  leave the fact out entirely.
- Any file whose name starts with `.env` is fenced off. Asking for one is
  refused; work from the code, and report what the code says the file holds.

## When you are done

Stop once the marker lines are written. Do not offer to make changes and do not
ask a question. Egma reads your marker lines, not your prose.
