---
name: integrate-egma
description: Integrate a repository's voice agent with Egma. Use when finding the agent, connecting a Retell agent, adding the Egma SDK to a LiveKit worker, or running that LiveKit worker locally for an Egma run.
---

# Integrate Egma

Complete only the phase the task requests. For a full onboarding, complete the
phases in this order:

1. Read [references/find-voice-agent.md](references/find-voice-agent.md) and
   identify the exact agent, entrypoint, prompt, tools, production path, and
   provider identity.
2. For Retell, read
   [references/connect-retell.md](references/connect-retell.md) before creating
   its Egma connection.
3. For a Python LiveKit worker, read
   [references/integrate-egma-sdk.md](references/integrate-egma-sdk.md) before
   adding the testing or monitoring entry.
4. When an Egma run needs that LiveKit worker on this machine, read
   [references/run-livekit-agent-locally.md](references/run-livekit-agent-locally.md)
   and keep the worker running until Egma ends the run.

Use repository evidence for repository facts. Keep credentials in the process
environment. Leave every `.env` file unread and unchanged.

Test authoring is a separate job. Use the `write-egma-tests` skill when a task
asks for tests.

Finish when every requested phase has a clear, evidence-backed outcome and no
unrequested phase changed the repository or an external service.
