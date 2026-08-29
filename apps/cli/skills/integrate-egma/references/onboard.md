# Onboard a voice agent with skills and the raw CLI

Read this file in full for a new or resumed integration. In this file,
`<egma>` means `egma` when installed and `npx --yes @egma/cli` otherwise; do
not type the angle brackets.

## Private state map

Read the requested outcome from the pasted prompt, start at `login`, perform the
sentence for the active state, and move only to a state named by that sentence;
remain in the active state while waiting for required human input or resolving
a safe refusal.

- `login` — Resolve the intended Egma platform, let login reuse valid credentials or keep it open while the developer approves the browser request without a reply or Enter press, and move to `discovery` after credentials are stored.
- `discovery` — Inspect the repository until one exact voice agent is selected, then move testing or both to `connection-setup`, monitoring to `monitoring-setup`, or stop at `no-agent` or `unsupported-platform` from the evidence.
- `connection-setup` — Apply the required Retell or LiveKit worker change, create or recover the exact simulation connection, record its receipt, and move to `test-writing`.
- `test-writing` — Let the CLI create the suite scaffold and list valid personas, use the test-writing skill for the smallest grounded suite and any required mock answers, and move to `publish`.
- `publish` — Use the operating skill to validate and publish the completed repository without losing remote work, then move to `run`.
- `run` — Use the operating skill to start and follow the first suite, pause only for a cost-bearing phone run, and move testing to `complete` or both to `monitoring-setup` after execution and grading are terminal.
- `monitoring-setup` — Apply the required Retell or LiveKit worker change, enable monitoring on the settled agent, read its exact status, and move to `complete`.
- `complete` — Stop when testing has a terminal run receipt, monitoring has an enabled status receipt, or both receipts exist for the same voice agent.
- `no-agent` — Stop without setup writes and report that no supported voice agent was found.
- `unsupported-platform` — Stop before remote setup and report the discovered Pipecat or Vapi boundary.

## Work from live facts

Resolve the platform from the URL in the task, an existing repository binding,
or hosted Egma for an unbound repository. Preserve an existing binding; a
different requested platform is an unsafe conflict that needs the developer.

For each active verb, read its current help and then use the command output as
the branch:

- option and required-field facts define the available public choices;
- required-secret facts name what the developer must supply securely;
- status, reason, and exit code say whether to continue, correct an input, or
  stop;
- stable IDs and receipts define identity; and
- printed recovery commands are the first recovery path.

Do not copy option lists or infer identity from a similar display name. Choose
an option without stopping only when the prompt, repository evidence, or a
single offered value makes it exact. Otherwise show the real choices and ask.

## Discover only what this outcome needs

Corroborate the running voice-agent path, not only a dependency. Account for
the platform, exact agent, runtime entrypoint or provider target, production
path, and provider identity used by the requested outcome.

- Retell testing also needs the provider prompt and tools returned by the
  connection context so tests match what Retell runs.
- LiveKit testing also needs the job entrypoint, exact dispatch target, agent
  construction, and real tool contracts.
- LiveKit monitoring needs the job entrypoint and production deployment path
  that will receive its environment handoff.
- Both needs the union of its platform's testing and monitoring facts.

Treat `retell-sdk` as Retell evidence and a running `livekit-agents`,
`livekit.agents`, or `@livekit/agents` worker as LiveKit evidence. Report
Pipecat or Vapi accurately even though the CLI cannot connect them yet. If
several agents remain credible, show their distinct evidence and ask which one
is the target.

## Follow the provider output

For Retell, let the connect command print its credential-custody note before
asking the developer for a key. For testing, request the non-secret provider
context using the current option named by help and carry that prompt and tool
evidence into the tests. When an ordinary first simulation does not name a
lane, use the low-cost text lane when offered; ask when the requested proof
requires another lane or the choice remains material.

For LiveKit, start with the incomplete connect command and follow its modality,
access-variant, public-field, and secret facts until the target is exact. For an
ordinary first end-to-end simulation with no requested modality, use chat when
offered. Ask when chat is unavailable, audio is part of the proof, or several
access variants remain materially different. Treat the LiveKit URL as a
project boundary, not as worker identity.

Before either LiveKit setup state, read
[livekit-worker.md](livekit-worker.md) and make only the source changes required
by the selected outcome. Run the repository's focused checks before continuing
to remote setup.

For both outcomes, create the simulation connection first, then enable
monitoring on that recorded agent. Reuse its settled identity and any secure
provider input still available to the process instead of creating a second
logical agent or asking the developer to reveal a secret again.

## Let each owner write its files

The CLI owns the repository binding, agent and connection records, suite
manifest, and all stable IDs. Use its suite-creation path rather than creating
those files by hand. If the repository already points at remote suites, use the
`egma` skill to synchronize them before creating another suite.

Use only personas listed by the current CLI or already recorded validly in the
repository. Then use `write-egma-tests` for every test and for LiveKit's
project-wide and test-specific mock answers. Start with the smallest grounded
suite that proves the requested path; preserve any cases the developer supplied
instead of filling an arbitrary quota.

Use the `egma` skill for validation, publication, the run, and result reading.
The original end-to-end prompt already authorizes the normal publish and chat
run in this flow, so continue without another approval request. A phone run is
the exception: state the exact target and simulation count, warn that it can
cost money, and wait for explicit approval immediately before starting it.

## Recover without duplicating remote work

When a command reports that this machine is not signed in, complete login and
repeat only that refused operation. When it prints a receipt or recovery
command, keep the receipt and run the exact recovery command instead of
reconstructing flags or repeating the remote write.

If a remote write becomes unreachable before any receipt, treat its result as
unknown. Use the current help and the same settled public provider identity to
look for the equivalent target without writing another one. Pause when exact
identity still cannot be proved. Let the `egma` skill handle repository version
conflicts and run idempotency; pause only when preserving both sides is unsafe
or a phone run would be repeated.
