---
name: egma
description: Operate Egma from a repository — inspect the egma folder, keep tests in step with the platform, start a run, and explain trace grades. Use when working with Egma, running the tests in egma/, synchronizing them with pull or push, or reading what a run returned.
---

# Operate Egma from this repository

Egma puts the developer's voice agent under pressure and grades what it did.
The repository holds an `egma/` folder of tests. The Egma platform holds their
versioned copies and every run.

Use `egma` when it is installed. Otherwise use `npx --yes @egma/cli` as the
command prefix; do not require a global install. Before running an operation,
run:

```sh
egma --help                          # installed command
npx --yes @egma/cli --help           # clean-machine fallback
```

Use only one of those forms for the task. Treat its output as the authority for
current verbs, flags, output fields, and exit codes. For a read-only explanation
of output the developer already supplied, no command is needed. Use this skill
for the stable post-onboarding workflow around the commands.

## Read the repository state

Read `egma/config.yaml` before acting. Format 3 names one **project**, its
**agents**, and the **connections** nested under each agent. Suites belong to
the project and live below `egma/tests/`; a run selects one suite, agent, and
connection together.

The folder has this shape:

```text
egma/
  config.yaml     format 3 platform, project, agents, and connection modalities
  mock-tools.md   what Egma answers for the agent's tools with
  tests/
    release/      one local directory per suite
      suite.yaml  stable suite id and mutable display name
      *.md        zero or more tests in this suite
    regression/   another suite in the same project
      suite.yaml
      *.md
```

The config hierarchy is:

```yaml
format: 3
platform:
  origin: https://app.egma.ai
project:
  id: prj_...
  name: Voice agents
agents:
  - id: agt_...
    name: Front desk
    connections:
      - id: con_...
        name: livekit_voice-1
        modality: voice
  - id: agt_...
    name: After hours
    connections: []
```

Format 3 is strict. Every connection has `modality: chat` or `modality: voice`.
The CLI has no reader, migration, or alias for an older folder format. Report
that refusal as written.

When the developer asks to onboard a repository, add its first voice agent, or
set up monitoring, use the `integrate-egma` skill. That skill owns discovery,
provider setup, the first suite, LiveKit source integration, and the human
approval gates. This skill starts from an existing `egma/config.yaml` and does
not reconstruct onboarding.

Everything in the folder is safe to commit. Treat fields such as `format`,
`version`, `identity_revision`, and persona ids as Egma-owned sync state.
Preserve them when editing an existing file. For test authoring, follow the
`write-egma-tests` skill when it is available.

## Keep the folder and Egma in step

```sh
egma pull
egma push
```

Run `egma pull` to bring the platform's current versions into the repository.
Before `egma push`, run `egma validate`, show the validated local changes, and
get explicit developer approval for the remote write. Then push the reviewed
change.

`push` validates and sends the complete repository as one change. It refuses a
stale file when the platform has moved on. Preserve the other person's work:
pull, read the change, reconcile it in the file, and push again. Keep every sync
pin in place during that recovery. Removing a local file does not delete its
platform record.

Egma relays platform refusals with the file and reason. Fix the named file and
repeat the same command. Keep the refusal text intact when reporting it.

## Understand mock tools

A **mock tool** answers for one of the voice agent's tools during a simulation.
Project-wide answers live in `egma/mock-tools.md`. A test-specific answer lives
inside that test file under `## Mock tools` and is versioned with the test.

Removing a project-wide block locally does not delete it from Egma. A later
pull restores it. Edit the block when changing its answer.

## Start and follow a run

```sh
egma run <suite-directory> [--agent <name-or-id>] [--connection <name-or-id>]
```

A **run** executes the complete suite in the named direct directory against the
selected agent over the selected connection. When there is one runnable target,
Egma uses it. When there are several agents or several connections under the
selected agent, use exact names or stable IDs. The local suite must exactly
match the platform before Egma starts it. Each test produces one **simulation**
per persona.

Before starting the command, name the suite, agent, connection, modality, and
expected simulation count and get explicit developer approval. For a phone
connection, state that the run starts real phone simulations and can cost money
immediately before asking. Never retry a phone run without fresh approval.

The command prints `idempotency-key` before it sends the start request, then
prints identifiers, a results address, execution progress, and grading
progress. Keep that key with the receipt. It waits until execution and all
requested trace grading are terminal. A simulation that failed or was canceled
before it produced a completed trace has no grading work to wait for. Use the
printed address when detailed evidence is needed. If the address is missing,
ask for the saved command output; do not start another run only to recover it.

Use `--no-follow` when the developer asks to start the run and return without
waiting:

```sh
egma run release --no-follow
```

The run continues on Egma after the command returns.

## Read grades without inventing an overall verdict

A **metric** is an observed fact, such as duration or latency. A **grader** uses
trace evidence, test values, or metrics to assign one normalized score from
`0` through `1`. Each grade shows the grader's pass threshold and its individual
result: `passed`, `failed`, or `errored`.

Expected behaviors is one grader. It evaluates the test's behavior statements,
keeps the result of each statement in its details, and returns one normalized
score for the trace. Report the score and the exact failed assertions with their
evidence. If grading failed, report the stored error; do not turn it into a low
score or an agent failure.

When every selected grader has a score, Egma may show their arithmetic mean as
the **combined score**. This number is for comparison only. It is not a test,
suite, run, or trace pass/fail result. A low score does not make `egma run` fail.
An execution error or grading-system error does.

Grading state is operational:

- `not_requested` — no grader was selected for the trace.
- `pending` — grading was requested but has not started.
- `running` — a worker is grading the trace.
- `complete` — all requested graders produced scores.
- `error` — requested grading ended with an operational error.

A scope or modality mismatch produces no grade row. Do not call it skipped.
Read the trace evidence before changing a test. Keep a useful test strict when
it exposes a real voice-agent problem.

## Recover from common refusals

- If the command says the developer is not signed in, run `egma login`.
- If no `egma/` folder exists, confirm the working directory. Run `egma init`
  only as part of an approved onboarding through the `integrate-egma` skill.
- If `egma run <suite-directory>` reports `not-pushed` or `unknown`, run
  `egma validate`, show the changes, get push approval, resolve any refusal,
  and then ask again before starting the run.
- If a failed or interrupted run printed a `run:` ID, the remote run exists.
  Use that ID and its results address; do not create another run to recover it.
- If a run transport failure printed an `idempotency-key` but no `run:` ID,
  the remote result is unclear. Get fresh run approval, then repeat the exact
  same suite, agent, connection, test versions, and run name with
  `--idempotency-key <printed-key>`. Never reuse that key for changed inputs or
  a new intended run.
- If the platform refuses a command, report its sentence as written and fix
  the named input.

## Use Egma's words

| Word | Meaning |
| --- | --- |
| `agent` | the developer's voice agent under test |
| `mock tool` | Egma's answer for one of that agent's tools |
| `persona` | the synthetic person who speaks to it |
| `test` | one authored situation plus what should happen |
| `test suite` | a named container of tests in one project |
| `run` | one execution of a complete suite against one agent |
| `simulation` | one test executed once inside a run |
| `metric` | an observed fact, such as duration or latency |
| `grader` | logic that assigns one normalized score to a trace |
| `grade` | one grader's score, details, threshold, and derived result |
| `combined score` | the display-only mean of all selected grader scores |
| `grading state` | operational progress of the trace's requested grading |
