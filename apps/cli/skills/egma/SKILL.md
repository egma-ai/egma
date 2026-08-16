---
name: egma
description: Drive Egma from this repository — read the egma folder, keep tests in step with the platform with pull and push, start a run, and read what came back. Use when the developer asks about Egma, about the tests in egma/, about running them, or about what a run said.
---

# Drive Egma from this repository

Egma puts the developer's voice agent under pressure and grades what it did.
This repository holds part of that: an `egma/` folder of tests, committed like
any other code. The rest lives on the Egma platform, which is the versioned
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
  mock-tools.md   what Egma answers for the agent's tools with
  tests/          one markdown file per test
```

Read `egma/config.yaml` first. It names the **agent** — the developer's voice
agent, the thing under test — the **connection** Egma reaches it over, and the
**test suite** this folder is. Each carries a name a person reads and an id
Egma uses. Nothing in the folder is secret, so all of it is committed.

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
  one. A test with none can never be red, so Egma will not store it.
- **`version:`** is Egma's. `pull` and `push` write it. Never write or edit
  that line yourself: it is how Egma knows what this file is a draft of.

## The mocked world

A **mock tool** answers for one of the agent's tools while a simulation runs, so
a test never reaches the real backend and can ask for the branch it needs — an
empty calendar, a booking service that is down. The project's own live in
`egma/mock-tools.md`, the tool named in the heading and the answer in the block
under it:

`````markdown
## Mock tools
### check_availability
```json
{
  "answer": { "slots": [] },
  "delay_ms": 250
}
```
`````

- **`answer`** is whatever that tool returns — any shape, including `null`.
- **`error`** instead of `answer` is the failure it raises. One of the two,
  never both.
- **`delay_ms`** holds the answer back, so a mocked backend takes as long as the
  real one. Leave it out for none.
- **`agents`** is a list of agent names this mock tool applies to. Leave it out
  and it applies to every agent in the project, which is what keeps two prompt
  variants comparable.

A test that needs a different answer writes the same section into its own file,
under the expected behaviors. That override belongs to the test and is versioned
with it; the project's mock tools are the one authored thing Egma does not
version, so pushing an edit writes over what was there.

Neither verb removes one. A block taken out of `egma/mock-tools.md` comes back
on the next `egma pull`, exactly as deleting a test file does not delete the
test.

## Keeping the folder and Egma in step

```sh
egma pull     # writes Egma's current versions into these files
egma push     # uploads what is in these files
```

Sync is always a verb somebody runs. Nothing syncs in the background.

`push` compares each file's pinned version against what Egma holds and
**refuses when Egma has moved on**, naming every test that moved. That is not a
problem to work around — it means somebody edited the same test in the
dashboard. Run `egma pull`, read what changed, reconcile it in the file, then
push again. Never delete a `version:` line to get past the refusal; that
discards the other person's work.

`push` also relays Egma's own refusals word for word. Fix the file it names.
Every rule about what a mock tool may answer with — one branch and not two, how
long a delay may be, how large an answer may be — is Egma's and is answered at
Egma's door, so the sentence you get back is the whole of what to fix.

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
results: http://localhost:3101/runs/run_01K…
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
verdict. The run carries on regardless — it happens on Egma, not here.

## The four verdicts, and why you must keep them apart

A **verdict** is `passed`, `failed`, `skipped` or `errored`.

- **`passed`** — the agent did what the test expected.
- **`failed`** — it did not. This is a real problem in the agent.
- **`skipped`** — nothing was judged. The test needed something this connection
  cannot do, or a grader had nothing it could score here.
- **`errored`** — the simulation never happened. The agent was never reached,
  or Egma itself broke.

**Never report `skipped` or `errored` as `failed`.** A test that could not run
is not a test that failed, and telling the developer their agent is broken when
Egma was is the fastest way to lose their trust in both. Say which of the four
it was, and say the count of each.

A test passes in a run when every simulation of it passed.

## When something is wrong

- **Not signed in** — run `egma login`. It opens a browser and finishes by
  itself. Do not ask the developer for a key.
- **No egma folder** — you are in the wrong directory, or this repository has
  not been onboarded. `egma init` makes the folder; the full `egma` wizard
  walks the whole way from nothing.
- **`egma run` refused** — the sentence Egma printed is Egma's own. Give it to
  the developer as it stands. Do not guess at what it meant.
- **`egma run` said `not-pushed` or `unknown`** — the folder and Egma do not say
  the same thing, so nothing was started. Run `egma push`, then run again. Never
  work around this by running anyway: a run over what Egma holds would come back
  green about words the developer's files do not say.
- **A test is red** — read the simulation on the results page before changing
  anything. A failing test is information about the voice agent, and deleting
  it or loosening its expected behaviors to get a green suite destroys the only
  thing Egma is for.

## Words to use exactly

They are not interchangeable, and the developer's team uses them precisely.

| Word | Means |
| --- | --- |
| `agent` | the developer's voice agent, under test — never you |
| `mock tool` | Egma's answer for one of that agent's tools |
| `persona` | the synthetic person who speaks to it |
| `test` | one authored situation, plus what should happen |
| `test suite` | a saved selection over a project's tests |
| `run` | one execution of a selection against one agent |
| `simulation` | one test executed once inside a run |
| `verdict` | `passed`, `failed`, `skipped` or `errored` |
| `grader` | the logic that produces a verdict |
