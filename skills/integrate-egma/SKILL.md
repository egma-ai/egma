---
name: integrate-egma
description: Onboard a repository's Retell or LiveKit voice agent with Egma for simulation testing, production monitoring, or both. Use when finding or connecting the agent, creating its first suite, wiring a LiveKit worker, or reaching the first run through skills and the raw CLI.
---

# Integrate Egma

Run this workflow inside the coding agent the developer is already using. This
skill and Egma's raw CLI are the complete integration surface.

## Choose the requested outcome

Complete only the phase the task requests. For a full onboarding, read
[references/onboard.md](references/onboard.md) and follow it through the
requested terminal state:

- **testing** ends with one reviewed suite pushed and one run followed;
- **monitoring** ends with production monitoring enabled and its status read;
- **both** completes both outcomes for the same voice agent.

When the request does not choose one, ask the developer to choose testing,
monitoring, or both. Do not silently turn monitoring into testing or start a
run for a monitoring-only request.

## Bootstrap the raw CLI

Use `egma` when it is installed. Otherwise use `npx --yes @egma/cli` as the
command prefix; do not require a global install. Bare `egma` only prints the
skill installation and coding-agent handoff. It does not sign in or perform an
onboarding operation. Use command-specific `--help` when an option needs
confirmation, and treat the help, output fields, and exit codes as the current
authority. In a full onboarding, `login` is the first operational command.

## Route each phase

- For repository discovery, read
  [references/find-voice-agent.md](references/find-voice-agent.md).
- For a Retell testing connection, read
  [references/connect-retell.md](references/connect-retell.md).
- For a LiveKit testing connection, read
  [references/connect-livekit.md](references/connect-livekit.md).
- Before changing a LiveKit worker, read
  [references/integrate-livekit.md](references/integrate-livekit.md).
- For LiveKit testing, read
  [references/author-livekit-mocks.md](references/author-livekit-mocks.md)
  after the first tests exist.
- When a run needs a local LiveKit worker, read
  [references/run-livekit-agent-locally.md](references/run-livekit-agent-locally.md).
- For the test files themselves, use the `write-egma-tests` skill after the
  suite exists and Egma has listed valid personas.

Read only the references for the active platform and phase.

## Keep the human boundary explicit

Keep discovery read-only. Use committed source for repository facts. Keep
credentials in standard input or the process environment. Do not read or edit
an `.env` file yourself. The only exception is the CLI's documented safe write
during LiveKit monitoring setup; let the CLI own that write and do not inspect
its values. Never repeat a credential in a command, transcript, diff, or report.

Before a remote write, name the platform, agent, connection or monitoring
target, modality, and resources the command will create or update. Continue
only after the developer approves that exact setup. After local authoring,
show the validated files and ask separately before `egma push`. Ask again
before `egma run`; for a phone connection, state that it starts real phone
simulations and can cost money immediately before asking.

Finish only when every requested outcome has a command receipt, every local
change has been read back, and no unrequested repository or remote resource
changed.
