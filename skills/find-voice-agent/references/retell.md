# Trace Retell repository evidence

Use committed repository evidence as the authority. The field names below are
search hints; the SDK use and configuration in this repository decide what is
true.

## Confirm Retell is part of this voice agent

Strong evidence includes a `retell-sdk` import used by the entry point, an SDK
create or update operation for an agent or response engine, or committed
configuration that connects an `agent_` reference to a response engine. A
dependency, README mention, or `RETELL_API_KEY` name alone is a lead.
Corroborate it before naming the voice agent as Retell-based.

## Trace the agent and response engine

Retell commonly separates the voice agent object from the response engine that
holds its prompt and tools:

- A Retell-managed engine commonly carries a type such as `retell-llm` and an
  `llm_id`. When committed configuration proves this shape, report that the
  response engine is Retell-managed and that its prompt content is absent from
  the repository unless a sync source is also present. Describe it as
  configured in the Retell dashboard only when committed documentation or code
  proves that; otherwise report the external Retell boundary without naming its
  editor.
- A repository-managed engine commonly carries a type such as `custom-llm` and
  a websocket URL. Follow that server entry point to the code that constructs
  the prompt and registers tools.
- A repository can author a prompt locally and push it into Retell. Look for an
  SDK update that reads a prompt file and sends fields such as
  `general_prompt`. Report both the authored file and the script or workflow
  that publishes it.
- For another response-engine shape, report the exact type and fields found
  instead of forcing it into these examples.

Absence of a prompt file does not prove dashboard configuration. Without a
committed response-engine link or publishing path, mark the prompt source
unknown.

## Trace tools

Search Retell configuration and SDK writes for `general_tools`, state-level
tools, and state prompts. For custom tools, follow each configured URL to the
repository route or handler it reaches. Keep Retell-provided tools separate
from handlers this repository owns. If tool configuration exists only outside
the repository, state that boundary and mark the tool list unknown.

## Trace production and identifiers

Look for SDK create or update scripts, CI workflows, service deployment files,
webhook routes, and custom-LLM websocket services. A missing deployment file is
`not found in this repository`, not proof of a manual dashboard deployment.

Report the path that records an `agent_` or `llm_` identifier. Do not print
identifier or API-key values, and leave `.env` files unread.

## Retell completion criteria

Before returning to the main report, account for the response-engine type,
prompt boundary, tool boundary, production path, and identifier location. Back
each known fact with a repository path and mark the rest unknown.
