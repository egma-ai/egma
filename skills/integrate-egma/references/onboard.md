# Onboard a voice agent with skills and the raw CLI

This is the full integration sequence. In command examples, `<egma>` means the
chosen command prefix: `egma` when installed, otherwise
`npx --yes @egma/cli`. Do not type the angle brackets.

## 1. Sign in

Resolve the platform from an explicit `--url`, an existing binding in
`egma/config.yaml`, or hosted Egma for an unbound repository. Do not replace an
existing binding as part of onboarding.

The coding agent runs `<egma> login` with the selected `--url`. This is the
first operational command in a full onboarding. If it prints a device code and
approval address, show them and wait. Browser approval is the developer's
action. Continue only after `status: stored` or `status: already-stored`.

## 2. Discover one voice agent

Read [find-voice-agent.md](find-voice-agent.md) and inspect the repository
without changing it. Account for the platform, agent name, entrypoint, dispatch
name, prompt, tools, production path, and provider identifier location.

If several credible voice agents remain, show the evidence for each and ask
which one to integrate. If the platform is unsupported by the CLI, stop with
the evidence and the unsupported boundary.

Ask for the outcome when it is still unknown: testing, monitoring, or both.
For LiveKit, apply [integrate-livekit.md](integrate-livekit.md) in that final
mode and run the repository's focused checks before any remote setup.

## 3. Approve and create remote setup

For LiveKit testing, read [connect-livekit.md](connect-livekit.md) and use its
deliberately incomplete read-only command when the platform choices are still
unknown. Then present one setup plan that names the Egma platform, exact voice
agent, and provider. When testing is requested, also name the Egma agent and
connection to create or reuse, testing modality and access method, and proposed
suite directory and display name. When monitoring is requested, name the
monitoring target. Get explicit approval before the first remote write. A
changed resource, target, modality, or access method needs new approval.

For a testing or both outcome, create the connection. Ask Retell to include its
non-secret provider context:

```text
<egma> connect --platform retell --show-context [provider choices]
<egma> connect --platform livekit [provider choices]
```

Use only the command for the discovered platform. Read
[connect-retell.md](connect-retell.md) or
[connect-livekit.md](connect-livekit.md) for its exact inputs. Supply
credentials through standard input or the process environment. When the
command returns an unchosen status, present its listed options and ask the
developer; do not infer from a similar name or select a paid lane. For Retell,
keep the context receipt for test grounding. It may contain the
provider-managed prompt and tools, but it must not contain credentials.
LiveKit test grounding comes from committed repository evidence.

Monitoring-only does not need a simulation connection, suite, tests, or run.
Skip to step 8 after the approved source integration.

## 4. Create the first suite from valid personas

Run `<egma> personas` and keep the returned names and stable IDs as the only
valid persona values for new tests. If Egma lists none, stop and ask the
developer to create or make a persona available before authoring files.

Use the approved short portable directory and display name, then run:

```text
<egma> suite create <directory> --name <display-name>
```

This is a remote write covered by the setup approval. Continue only after the
command reports the remote suite ID and the local `suite.yaml`. When the
repository already points at a project with remote suites, run `<egma> pull`
before creating anything.

## 5. Author tests and the mocked world

If the developer supplied existing cases, convert only those cases first. Fill
the first suite to three or four distinct, grounded tests; do not create extra
tests to reach a larger count. For Retell, use the provider context from
`connect --show-context`. For LiveKit, use committed repository evidence. On
both platforms, use only the personas returned by `egma personas`.

Use the `write-egma-tests` skill for each Markdown test. For LiveKit testing,
also read [author-livekit-mocks.md](author-livekit-mocks.md) and write the
project-wide mocked world plus only the test-specific overrides the cases need.
Retell testing does not add LiveKit mock-tool setup.

## 6. Validate, review, and push

Run the repository's focused checks for source edits, then run:

```text
<egma> validate
```

Fix every named file and repeat validation until the complete repository is
valid. Read every changed file back. Show the developer the exact source,
dependency, `egma/config.yaml`, suite, test, and mock-tool changes. Ask for
explicit publish approval; approval of setup in step 3 is not approval of
these authored files.

After approval, run `<egma> push`. Push is one atomic full-repository write. If
it reports a version conflict, run `<egma> pull`, inspect and reconcile the
remote work, validate again, show the new diff, and get new publish approval.

## 7. Approve and run the suite

Name the suite, agent, connection, modality, and expected simulation count.
Ask for explicit run approval. For a phone connection, state that the command
starts real phone simulations and can cost money immediately before asking.

For Retell and for an already-running LiveKit deployment, run:

```text
<egma> run <suite-directory> [--agent <name-or-id>] [--connection <name-or-id>]
```

For a local LiveKit worker, use
[run-livekit-agent-locally.md](run-livekit-agent-locally.md) and pass the three
worker flags to the same `egma run` command. Follow the run until execution and
grading are terminal. Report behavior verdicts as product findings and command
failures as operational failures.

## 8. Enable monitoring when requested

Restate the exact agent, provider target, and remote monitoring resources. Get
explicit monitoring approval immediately before the remote write; setup,
publish, and run approvals do not substitute for it. Then run the command for
the discovered platform:

```text
<egma> monitoring enable --platform retell [target choices]
<egma> monitoring enable --platform livekit [target choices]
```

Use the command's listed choices when more than one provider agent exists.
Retell credentials stay on standard input. On LiveKit, let the CLI own its safe
environment-file write and printed deployment handoff; do not open an
environment file or copy credential values into the report.

Then run `<egma> monitoring status` for the exact Egma agent and report whether
production ingestion is enabled. A both outcome is complete only when the run
and monitoring status have both reached their terminal criteria.

## Recover without duplicating work

Use the exit code and `status:` field as the branch:

- login `denied`: stop; do not start another browser request unless the
  developer asks. For `expired` or `interrupted`, explain that nothing was
  stored and let the developer decide when to repeat login.
- `not-signed-in`: run login and repeat only the refused operation.
- `unchosen` or a status beginning `unchosen-`: show the printed options, ask
  the developer, and repeat with the exact chosen ID or value.
- `missing-fields`, `invalid-field`, or `name-taken`: correct the named public
  input. Get new setup approval when the target or resource name changes.
- `no-key`, `invalid-key`, `no-credentials`, or `invalid-credentials`: ask the
  developer to correct the named secure input; never print or inspect it.
- `no-agents`, `no-numbers`, or no available persona: stop and report the
  missing provider resource. Do not manufacture one.
- suite `local-write-failed`: run `egma pull`; do not create a second suite.
- validation `invalid-repository` or `invalid-personas`: fix every named local
  file; no remote retry is needed.
- push `turned-away`, or a `refused` status that reports a version conflict:
  pull, reconcile, validate, review, and approve again.
- run interruption or transport failure: first check whether output contains a
  `run:` ID. A run ID means the remote run exists; do not create another just
  to recover progress or its results address.
- local-worker refusal before a `run:` ID: fix only the named environment,
  entrypoint, manifest, dependency, or LiveKit CLI problem, then get fresh run
  approval. No remote run exists yet.
- monitoring remote success with a failed repository record: use the printed
  receipt with `egma monitoring record`; do not enable a second source.

Never retry a phone run or another cost-bearing operation without fresh
developer approval.
