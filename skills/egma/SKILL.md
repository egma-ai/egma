---
name: egma
description: Operate Egma from a repository — inspect the egma folder, keep tests in step with the platform, start a run, and explain its verdicts. Use when working with Egma, running the tests in egma/, synchronizing them with pull or push, or reading what a run returned.
---

# Operate Egma from this repository

Egma puts the developer's voice agent under pressure and grades what it did.
The repository holds an `egma/` folder of tests. The Egma platform holds their
versioned copies and every run.

Before running an Egma command, run:

```sh
egma --help
```

Treat that output as the authority for current verbs, flags, and exit codes.
For a read-only explanation of output the developer already supplied, no
command is needed. Use this skill for the stable workflow around the commands.

## Read the repository state

Read `egma/config.yaml` before acting. It names the **agent** under test, the
**connection** Egma uses to reach it, and the **test suite** represented by this
folder.

The folder has this shape:

```text
egma/
  config.yaml     what this folder points at — names and ids
  mock-tools.md   what Egma answers for the agent's tools with
  tests/          one markdown file per test
```

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
Run `egma push` to send reviewed local changes back.

`push` refuses a stale file when the platform has moved on. Preserve the other
person's work: pull, read the change, reconcile it in the file, and push again.
Keep every sync pin in place during that recovery.

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
egma run
```

A **run** executes this test suite against the agent over the selected
connection. Each test produces one **simulation** per persona.

The command prints identifiers, a results address, simulation progress, and a
summary with one count for each verdict. The summary counts simulations, not
tests. Use the printed address when detailed evidence is needed. If the address
is missing, ask for the saved command output; do not start another run only to
recover it.

Use `--no-follow` when the developer asks to start the run and return without
waiting:

```sh
egma run --no-follow
```

The run continues on Egma after the command returns.

## Keep the four verdicts separate

A verdict is one of:

- **`passed`** — the agent did what the test expected.
- **`failed`** — the agent did not do what the test expected.
- **`skipped`** — nothing was judged because the test or grader could not
  apply.
- **`errored`** — the simulation did not complete.

Never report `skipped` or `errored` as `failed`. Report the count of all four.
A test passes only when every simulation of that test passed.

For a failed simulation, report the unmet expected behavior and the transcript
or tool evidence. For a skipped or errored simulation, report Egma's stated
reason. Do not invent a cause from the summary count alone.

Read that evidence before changing a failed test. Keep a useful test strict
when it exposes a real voice-agent problem.

## Recover from common refusals

- If the command says the developer is not signed in, run `egma login`.
- If no `egma/` folder exists, confirm the working directory. Run `egma init`
  only when the developer asks to onboard this repository.
- If `egma run` reports `not-pushed` or `unknown`, run `egma push`, resolve any
  refusal, and then start the run again.
- If the platform refuses a command, report its sentence as written and fix
  the named input.

## Use Egma's words

| Word | Meaning |
| --- | --- |
| `agent` | the developer's voice agent under test |
| `mock tool` | Egma's answer for one of that agent's tools |
| `persona` | the synthetic person who speaks to it |
| `test` | one authored situation plus what should happen |
| `test suite` | a saved selection over a project's tests |
| `run` | one execution of a selection against one agent |
| `simulation` | one test executed once inside a run |
| `verdict` | `passed`, `failed`, `skipped`, or `errored` |
| `grader` | the logic that produces a verdict |
