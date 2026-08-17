# Trace LiveKit repository evidence

Use committed repository evidence as the authority. The names below are search
hints; the installed SDK version and this repository's code decide what is true.

## Confirm LiveKit is part of this voice agent

Strong evidence joins a `livekit-agents` or `@livekit/agents` dependency to the
entry point that starts a worker. Common signs include `livekit.agents` imports,
`AgentSession`, `WorkerOptions`, `defineAgent`, and a worker entry function. A
dependency, `LIVEKIT_URL`, or README mention alone is a lead. Corroborate it
before naming the voice agent as LiveKit-based.

## Trace the prompt and tools

Follow the worker entry function to the `Agent` and `AgentSession` it starts.
Trace instructions from their authored source through any templates, loaders,
or subclasses. If the code loads instructions from an external store, report
that boundary and the repository code that performs the load.

Trace tools from the agent or `AgentSession` configuration to each tool
definition and handler. Python projects often register decorated function
tools. TypeScript projects often build a tool context or tool map. Use the code
found in the repository instead of assuming either shape.

## Trace production and identity

Follow the command that runs the worker in production, then inspect its
container, process definition, or deployment workflow. Record where the worker
or dispatch agent name is configured when one exists. Treat the LiveKit server
URL as a connection boundary, not as the identity of the voice agent.

Leave `.env` files unread. Report paths that declare required variable names;
never print URLs, keys, secrets, tokens, or metadata values.

## LiveKit completion criteria

Before returning to the main report, account for the worker entry point, prompt
boundary, tool boundary, production path, and agent-name location. Back each
known fact with a repository path and mark the rest unknown.
