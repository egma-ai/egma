# The grader

The service that judges finished conversations — the same graders, both sources.
A simulation reaching its terminal transition becomes claimable work in the same
commit that lands it; a production conversation becomes claimable when its
telemetry says it is over. This service takes the work, reads the conversation,
resolves the graders that apply to it, executes each one, and writes a verdict
row per judged assertion.

It claims its work rather than being sent it, so it has no inbound surface at
all: no port, no route, nothing to authenticate, nothing to expose. Scaling it
is running more copies — they claim from one queue, take what they have room
for, and distribute between themselves with nothing in front of them.

It sits on the control plane's side of the wire and reads the two stores
directly. The API process gains nothing from grading existing: no route, no
fan-out, no judge latency on a request path.

## What it does with one conversation

1. **Claim.** The oldest outstanding job, taken atomically, with a claimant
   label and a lease. Two copies never take the same conversation, and a copy
   that dies holding one loses it to whichever copy asks after the lease runs
   out.
2. **Read.** A simulation comes off its own row — transcript, events, measures —
   which is where a finished simulation already carries it. A production
   conversation has no row of its own and never will: it is read from the spans
   it arrived as, which are its whole record.
3. **Resolve.** One list through one filter, and no test is read: for a
   simulation, every running copy in the project whose scope includes
   simulations; for a production conversation, every copy whose scope includes
   production, each then asked whether this conversation is its turn, which is
   what the sampling rate decides. **A test names no graders** — where a copy
   applies is the copy's own setting, so pressing **Use** once makes a check
   that judges everything inside its scope and nobody has to remember to attach
   it to the next test somebody writes.
4. **Execute.** One function per library entry, behind one seam — what each one
   does is the section below.
5. **Write.** One row per judged assertion: the verdict word, a score, a
   one-line rationale, and the turns it cites. **No overall row is written
   anywhere** — a conversation's answer and a run's are folded from these rows
   at read time, so a headline can never disagree with the evidence under it.

Two rules run through all of it. **A simulation that never ran is `errored` for
every grader and never `failed`** — a broken test is not a broken agent. And **a
check that could not be made says so**: a measure this conversation does not
have is `skipped` and leaves the score's denominator; a measure recorded in a
shape Egma never writes is `errored`, because a corrupted row and a missing one
are different facts.

## The two lanes a verdict lands in

Every running copy carries **`required`**, and it decides what a failure is
allowed to do rather than whether the check is made at all.

- **`required: true`** — the default. The conversation cannot pass unless every
  assertion of this copy passes. A grader somebody bothered to switch on is one
  they expect to be believed.
- **`required: false`** — a **diagnostic**. Resolved, judged and written exactly
  like a blocking copy, its fraction reported beside the answer, and never able
  to fail a test or a run.

The engine does not read the flag. Both lanes are judged identically here, and
the split happens in the fold at read time, from the flag as it stands — a
diagnostic whose rows were never written would diagnose nothing, and one that
could redden a run would not be a diagnostic.

## The measure catalog, and the one module that computes it

A grader names the measure it reads as a string, and a string that names nothing
produces a grader that reads nothing, judges nothing, and is `skipped` forever.
The **measure catalog** — `packages/simulation-contract/measure-catalog.md`,
beside the two schemas, with `src/measures.ts` as the same list in code — names
every measure Egma records, **and now pins each one's span-level definition
beside its name**: the rule that says how it is computed from a conversation's
spans, or that no span carries it at all.

One shared measure module implements exactly those definitions
(`packages/metrics/src/from-spans.ts`), and it is the **only** computation
path for them. The metrics display reads through it and so does the `latency`
grader, for a simulation and a production conversation alike — so the number on
a screen and the number a verdict rests on are one piece of arithmetic and can
never disagree. Nothing is stored: a measure is the spans, reduced, at read time.

**The reduction is part of that**, and it is the half that is easy to lose. A
bound is held against one number — `worstSampleOf`, the strictest reading, until
the catalog's aggregations become something a grader can ask for — so the module
reduces and every surface reads the reduced figure. A page taking the maximum
for itself would look harmless and would be a second implementation of exactly
the number a verdict rests on, correct until the day the two reductions differ
and silent when they do. `packages/db/test/one-measure-path.test.ts` is the
drift alarm over all of it: it scans the source for a second reader of the timing
kind, a second nanosecond conversion, and a hand-rolled reduction, and it names
the files allowed to do each.

**A conversation Egma holds only part of is judged by nobody.** A read over the
store's span limit returns a prefix, and the worst measurement of a prefix is the
worst of that part rather than of the call. Both sources refuse it with the same
sentence; the read endpoint marks such measures `partial` rather than hiding
them, because a display may show what there is and may not claim it is the whole.

The module knows nothing about where a conversation came from. Identical spans
therefore produce identical numbers whether Egma conducted the conversation or a
real caller had it, which is what makes "passes in simulation, fails in
production" a fact about the agent rather than about two readers.

The grader factory's **write door refuses a measure a copy could not read** —
one the catalog does not name, and one it names but no span carries, which is a
real number arriving on the transition that ends a simulation and living on the
simulation row instead. Both would be a check that is `skipped` forever, and the
moment of writing is the only place anything can tell them from a measure a chat
conversation simply did not produce. The **Use** form's dropdown is fed from the
same list, so a developer is never offered something a write would refuse.

## The expected-behaviors grader: a test's own list, judged one at a time

Every project is created running a copy of it, so a first run is judged with no
setup at all, and deleting that copy is how a project stops being judged against
what its tests say.

**One independent judge call per behavior**, all in parallel, each producing its
own verdict row. The alternative — one call that reads the whole list — gives a
developer one blurred explanation and lets a judge trade a failed behavior off
against a passed one. Here each row names the behavior's position
(`behavior_1`, `behavior_2`, …) in the order the author wrote them — the key,
never the sentence.

**The words behind that key are fetched at display time**, from the **frozen
test version** the conversation was executed against, which never changes for
that conversation — so a position means the same sentence forever, and reading
against the test as it now stands is precisely what pinning exists to prevent.
That is `readAssertionWords` in the data-access module; a key nothing can place
is shown as itself rather than as a guess.

The isolation is structural: a judge is handed one criterion and the
conversation's evidence, and the evidence has nowhere for a second criterion to
be. No behavior's words can reach another behavior's judge.

**What a judge reads is a declared set** — the transcript numbered by turn, how
the conversation ended, the tools the agent called, and what was measured.
Text-only today; the recording is designed for and joins the same set when it
arrives.

**A behavior a judge cannot determine is `skipped`** and leaves the score's
denominator: a judge that could only say yes or no would guess, and a guess
dressed as a judgment is the false trust this product exists to kill. **A judge
call that fails after its retries is `errored` for that behavior alone** — its
siblings were separate calls and their answers land untouched.

Citations are turn references (`turn:5`) rather than span ids, because a
simulation read from its own header row has no spans yet. The prefix is what
lets a reader tell the two apart on the day both are in that column.

## Judges

A model-judged grader version owns its exact **provider and model**. The
deployment owns one current key for each provider. A project chooses which
grader copies run; it does not own or store a second model credential.

v1 ships the OpenAI provider and nothing else, behind a provider-shaped seam: a
second provider is a second file plus a line in one roster. Requests go to
`https://api.openai.com/v1/chat/completions` — one POST, one JSON body, one JSON
answer, no SDK.

The service loads the current deployment credential bundle once for each
claimed grading job. It resolves every selected grader model before any
executor starts. A missing selected key therefore fails the job as one unit and
writes no verdicts. It never becomes an agent failure.

**The selected key is closed inside the provider adapter, handed to `fetch`, and
written nowhere.** It is not in a grader, verdict row, log line, rationale, or
refusal. Code graders need no model and no provider key.

## Configuration

Everything arrives as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Where conversations, graders and tests are read from. |
| `CLICKHOUSE_URL` | (required) | Where verdicts are written. |
| `EGMA_PROVIDER_CREDENTIALS_SECRET_ID` | (unset) | AWS Secrets Manager secret holding the Egma Cloud provider bundle. Must be paired with `EGMA_PROVIDER_CREDENTIALS_REGION`. |
| `EGMA_PROVIDER_CREDENTIALS_REGION` | (unset) | AWS region of that secret. Must be paired with `EGMA_PROVIDER_CREDENTIALS_SECRET_ID`. |
| `EGMA_OPENAI_API_KEY` | (unset) | Self-host OpenAI key, used when the AWS source is not selected. |
| `EGMA_DEEPGRAM_API_KEY` | (unset) | Self-host Deepgram key, used when the AWS source is not selected. |
| `EGMA_CARTESIA_API_KEY` | (unset) | Self-host Cartesia key, used when the AWS source is not selected. |
| `EGMA_GRADER_CLAIMANT` | `grader-<host>-<pid>` | The name stamped on claims. |
| `EGMA_GRADER_CAPACITY` | `4` | Most conversations judged at once. |
| `EGMA_GRADER_HEARTBEAT_SECONDS` | `15` | How often a copy says it still holds a job. |
| `EGMA_GRADER_LEASE_SECONDS` | `120` | How long a claim survives a copy's silence. Must be well above the heartbeat. |
| `EGMA_GRADER_SWEEP_SECONDS` | `30` | The backstop, not the trigger — see below. |
| `EGMA_GRADER_TRACE_IDLE_SECONDS` | `300` | How long a production conversation must be quiet before it is judged without ever having been closed. |
| `EGMA_GRADER_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN` or `ERROR`. |

Naming both AWS variables selects Secrets Manager. After a claimed job resolves
its grader versions, the service reads the current secret once only if one of
them calls a model. The next model job sees a rotated key without a service
restart, while code-only grading does not depend on Secrets Manager. Naming
neither selects the self-host environment keys. A half-named AWS source is
refused at startup.

The database stores model choices, never model-provider keys. If the selected
source lacks a key required by any grader in the job, the job is released for a
later attempt before any executor or verdict write runs.

## How work reaches it

The transaction that lands a terminal transition writes the job **and** raises a
Postgres notification, so a running copy wakes on the commit rather than at the
top of some interval. Nothing a verdict waits for is on a timer, and this
service promises no latency anywhere.

A production conversation has no transaction to ride. It arrives at the OTLP
door as spans, in as many flushes as its exporter felt like sending, and the
door writes one queue row per conversation on the first flush that mentions it —
a queue write and a notification, never a judgment on a request path. When the
flush carrying the **root span** arrives, the conversation is over: an exporter
sends a span when the span *ends*, so the one span the whole conversation
happened inside reaching the door is the conversation having ended. The door
raises the same notification a terminal transition does, and the wake-up is
immediate.

`EGMA_GRADER_TRACE_IDLE_SECONDS` is the fallback for an exporter that never
closes a root span — a crashed agent, a framework that emits no session span.
There is nothing to be woken by, because the event to wait for is the absence of
events, so this half is a sweep by nature: a conversation nothing has arrived
for in longer than the window is claimable, and the pass every copy already
makes is what finds it.

`EGMA_GRADER_SWEEP_SECONDS` is the backstop underneath all of that, not the
mechanism: a notification raised while every copy happened to be restarting
reaches nobody, and a lease running out is a clock rather than an event. Both
are caught by asking again, which costs one indexed query.

## Sampling production, deliberately

A grader carries a `production_sample_rate`, and it is enforced by an
accumulator rather than by a coin toss. Each conversation adds the rate to the
grader's running total; crossing a hundred is that grader's turn and takes a
hundred back off. So 25% is literally every fourth conversation, and a customer
who watched four calls go past can be shown which one was judged and why the
other three were not — an answer randomness cannot give at any price.

A conversation a grader did not sample gets **no verdict row at all** from it,
not a `skipped` one: `skipped` means the check did not apply, and it applied
perfectly well. Nobody chose to spend a judgment on that call.

Sampling never touches simulations. A simulation is a conversation somebody
asked for, one at a time, and judging nine of ten of them would mean a report
missing a test for no reason anybody chose.

Scope and rate are live settings, so both take effect **forward only**. Pointing
a grader at production judges the next conversation and says nothing about the
ones before it: no back-filling, and no deleting the verdicts a wider scope had
already produced.

## Adding an executor for a library entry

One file, one line. `src/graders/contract.ts` says what every executor is handed
and what every one of them answers with; write a module that exports one of that
shape and name it in the roster in `src/graders/index.ts`, keyed by the entry's
own identifier. Nothing else changes — the claim, the read, the resolution, the
verdict rows and the fold are all written once, in the grader's vocabulary rather
than in any entry's.

An entry that is on the shelf and has no executor yet answers `errored` rather
than saying nothing, because a page that goes green because a grader quietly
judged nothing is the exact false trust this product exists to kill.

An executor that judges with a model receives one through the `judging` it is
handed. A code executor receives `null` and never asks a provider.

```ts
const judge = execution.judging.judge;
if (judge === null) {
  throw new Error("a model-judged grader reached execution without its judge");
}
const answer = await judge.ask({ criterion, evidence: judgeInputOf(conversation) });
```

Before any executor runs, the engine resolves every model-judged grader
version's exact `judge_model` against the credential bundle loaded for this
job. There is no project default and no provider fallback.

What `judging(…)` answers with is one thing and no more: **`ask`**, a function
that decides one criterion. The key is not on it, and that is the point:
nothing under `src/graders/` can reach one, so no grader type — today's or
tomorrow's — can put a key in a rationale, a row or a log.

**The verdict row does not record which judge answered**, and nothing hands out
a name for it to record. `judged_by` retired with the human corrections it
existed for: a person's word returns as the reserved `human` grader type,
writing its own rows under its own grader id, so the column had nothing left to
keep apart.

## Adding a judge provider

One file, one line, on the same terms. `src/judge/contract.ts` says what a judge
is asked and what it answers; write a module beside `src/judge/openai.ts` and
name it in the roster in `src/judge/index.ts`. The roster is keyed by the closed
provider list the database checks against, so a provider added there refuses to
build until it is told how to ask.

## Tests

```
pnpm db:up          # Postgres and ClickHouse, once
npx vitest run apps/grader
```

Both stores are real. Everything worth asserting here is one of their
behaviours: the notification a transaction raises, the lock that keeps two
copies off one conversation, and the store's identity collapsing a second
judgment onto the one it repeats rather than filing it beside it.

**The judge is a seam, and the whole suite runs on a scripted one** — answers
from memory, no key, no network. What that leaves untested is the wire, so one
live smoke asks a real OpenAI judge one question. It is opt-in, and with no key
in the environment it skips visibly rather than failing:

```
TEST_OPENAI_API_KEY=sk-... npx vitest run apps/grader/test/live-openai
```
