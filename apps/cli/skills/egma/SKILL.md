---
name: egma
description: Drive egma from this repository — read the egma folder, keep tests in step with the platform with pull and push, start a run, and read what came back. Use when the developer asks about egma, about the tests in egma/, about running them, or about what a run said.
---

# Drive egma from this repository

egma puts the developer's voice agent under pressure and grades what it did.
This repository holds part of that: an `egma/` folder of tests, committed like
any other code. The rest lives on the egma platform, which is the versioned
store.

You drive it with one command, `egma`. Every verb is headless: it asks nothing,
prints one fact per line as `key: value`, and answers with a number you can
branch on. You never need a human to read a screen for you.

Start here, every time:

```sh
egma --help
```

That is the authority on the verbs and the numbers. This file is the shape of
the work; `--help` is the current detail.

## What the folder says

```
egma/
  config.yaml     what this folder points at — names and ids
  tests/          one markdown file per test
```

Read `egma/config.yaml` first. It names the **agent** — the developer's voice
agent, the thing under test — the **connection** egma reaches it over, and the
**test suite** this folder is. Each carries a name a person reads and an id
egma uses. Nothing in the folder is secret, so all of it is committed.

One test is one file:

```markdown
---
name: missed-appointment-reschedule
personas: [impatient-regular]
version: tstv_01K…
---
## Scenario
The person missed yesterday's appointment and wants another one this
week. They are short of time and already annoyed.
## Expected behaviors
1. The agent acknowledges the missed appointment without blaming anyone.
2. The agent offers at least two other times.
3. The agent repeats the new time back before it ends.
```

- **`name`** is lower case with hyphens, and matches the file name.
- **`personas`** names who speaks to the agent. Leave the line out and the
  project's default persona applies — which is right for most tests. Name one
  only when the situation is about a particular kind of person.
- **`expected behaviors`** is an ordered list, and there is always at least
  one. A test with none can never be red, so egma will not store it.
- **`version:`** is egma's. `pull` and `push` write it. Never write or edit
  that line yourself: it is how egma knows what this file is a draft of.

## Keeping the folder and egma in step

```sh
egma pull     # writes egma's current versions into these files
egma push     # uploads what is in these files
```

Sync is always a verb somebody runs. Nothing syncs in the background.

`push` compares each file's pinned version against what egma holds and
**refuses when egma has moved on**, naming every test that moved. That is not a
problem to work around — it means somebody edited the same test in the
dashboard. Run `egma pull`, read what changed, reconcile it in the file, then
push again. Never delete a `version:` line to get past the refusal; that
discards the other person's work.

`push` also relays egma's own refusals word for word. Fix the file it names.

## Starting a run

```sh
egma run
```

A **run** is one execution of this folder's tests against the agent over the
connection. It pins the version of every test it executes, so what a run
executed can never change underneath it afterwards.

Each test produces one **simulation** per persona — the test executed once,
start to finish. `egma run` prints one line per simulation as it moves, a line
when a verdict lands, and a summary you can parse:

```
run: run_01K…
results: https://app.egma.ai/runs/run_01K…
simulation: missed-appointment-reschedule impatient-regular running
verdict: missed-appointment-reschedule impatient-regular passed
passed: 9
failed: 2
skipped: 1
errored: 0
pending: 0
simulations: 12
```

Pass `--no-follow` to start the run and return at once, without waiting for a
verdict. The run carries on regardless — it happens on egma, not here.

## The four verdicts, and why you must keep them apart

A **verdict** is `passed`, `failed`, `skipped` or `errored`.

- **`passed`** — the agent did what the test expected.
- **`failed`** — it did not. This is a real problem in the agent.
- **`skipped`** — nothing was judged. The test needed something this connection
  cannot do, or a grader had nothing it could score here.
- **`errored`** — the simulation never happened. The agent was never reached,
  or egma itself broke.

**Never report `skipped` or `errored` as `failed`.** A test that could not run
is not a test that failed, and telling the developer their agent is broken when
egma was is the fastest way to lose their trust in both. Say which of the four
it was, and say the count of each.

A test passes in a run when every simulation of it passed.

## When something is wrong

- **Not signed in** — run `egma login`. It opens a browser and finishes by
  itself. Do not ask the developer for a key.
- **No egma folder** — you are in the wrong directory, or this repository has
  not been onboarded. `egma init` makes the folder; the full `egma` wizard
  walks the whole way from nothing.
- **`egma run` refused** — the sentence egma printed is egma's own. Give it to
  the developer as it stands. Do not guess at what it meant.
- **A test is red** — read the simulation on the results page before changing
  anything. A failing test is information about the voice agent, and deleting
  it or loosening its expected behaviors to get a green suite destroys the only
  thing egma is for.

## Words to use exactly

They are not interchangeable, and the developer's team uses them precisely.

| Word | Means |
| --- | --- |
| `agent` | the developer's voice agent, under test — never you |
| `persona` | the synthetic person who speaks to it |
| `test` | one authored situation, plus what should happen |
| `test suite` | a saved selection over a project's tests |
| `run` | one execution of a selection against one agent |
| `simulation` | one test executed once inside a run |
| `verdict` | `passed`, `failed`, `skipped` or `errored` |
| `grader` | the logic that produces a verdict |
