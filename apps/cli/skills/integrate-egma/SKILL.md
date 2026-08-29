---
name: integrate-egma
description: Set up a repository's Retell or LiveKit voice agent with Egma for simulation testing, production monitoring, or both. Use for first-time discovery, provider connection, the first suite and run, or the required LiveKit worker changes; use the egma skill for later work in an existing Egma repository.
---

# Integrate Egma

This skill coordinates the first complete Egma integration inside the coding
agent the developer is already using.

## Route the request

- For a full setup or a resumed setup for simulation testing, production
  monitoring, or both, read [references/onboard.md](references/onboard.md) in
  full before running a command and follow its private state map to completion.
- For only a LiveKit worker source change, read
  [references/livekit-worker.md](references/livekit-worker.md).
- Use the `write-egma-tests` skill for test files and the mocked world.
- Use the `egma` skill after the first connection and suite exist for repository
  validation, synchronization, runs, and result interpretation.

## Trust the live interface

Use `egma` when installed and `npx --yes @egma/cli` otherwise. Read the current
help for the active verb, then branch on its printed facts, status, exit code,
receipts, and recovery commands. Those outputs own changing command syntax and
platform choices; this skill owns the integration order and safety boundaries.

Let the CLI create and update `egma/config.yaml`, suite manifests, and other
Egma-owned scaffold. Do not hand-write IDs or YAML that a command owns.

## Use the authority already given

An end-to-end setup prompt authorizes the normal local edits and remote setup,
publish, chat-run, and monitoring operations needed to finish that outcome. Do
not stop for repeated approval between states; the `egma` skill's normal
publish and chat-run steps are part of the same authority.

Pause only when the developer must approve browser login, supply a credential,
choose among genuinely different agents or provider options, resolve an unsafe
conflict, or authorize a real phone run that can cost money. Immediately before
a phone run, name its target and simulation count, warn that it can cost money,
and wait for explicit approval.

Keep credentials in the secure input or process environment named by the CLI.
Never place them in arguments, source, diffs, or reports, and do not read or
edit environment files. When LiveKit monitoring asks the CLI to make its
documented safe ignored-file write, let the CLI own it and report only the
non-secret receipt.

Finish when every requested outcome has a terminal command receipt, every
source change passes the repository's focused checks, and no unrelated local or
remote resource changed.
