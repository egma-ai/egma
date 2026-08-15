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
3. **Resolve.** For a simulation: every grader in the project whose scope
   includes simulations, plus the graders named by the test version the
   conversation was executed against. A grader named by both is one grader —
   and beside them, never among them, stands the built-in below. For
   a production conversation: the project's graders whose scope includes
   production, and nothing else — a real caller is in nobody's scenario, so no
   test's grader array reaches here and the built-in has no expected behaviors
   to judge against. Each of those graders is then asked whether this
   conversation is its turn, which is what the sampling rate decides.
4. **Execute.** One function per grader type, behind one seam. Three of the four
   are deterministic and one asks the project's judge; what each one does is
   the section below.
5. **Write.** One row per judged assertion: the verdict word, a score, a
   one-line rationale, and the turns it cites. **No overall row is written anywhere** — a conversation's answer and
   a run's are folded from these rows at read time, so a headline can never
   disagree with the evidence under it.

Two rules run through all of it. **A simulation that never ran is `errored` for
every grader and never `failed`** — a broken test is not a broken agent. And **a
check that could not be made says so**: a measure this conversation does not
have is `skipped` and leaves the score's denominator; a measure recorded in a
shape egma never writes is `errored`, because a corrupted row and a missing one
are different facts.

## The four authored types

| Type | Reads | Asks a model | Says |
| --- | --- | --- | --- |
| `metric_threshold` | one measure off the conversation | no | whether an aggregation of it holds against a threshold |
| `tool_calls` | the tool calls the simulator observed | no | whether the required tools fired and the forbidden ones did not |
| `phrase_match` | the transcript, per speaker | no | whether the required phrases were said and the banned ones were not |
| `llm_rubric` | the declared set a judge reads | yes | what a judge decided about the team's own criteria |

**Each of them names one assertion: its own type.** A `tool_calls` grader
holding three rules writes one row, not three, and the rationale names every
rule that was broken.

That is a deliberate decision with two halves. An assertion key must be stable
across a grader's versions and may derive nothing from its config, because the
fold counts one assertion once per grader and prefers the latest grading of it —
a per-rule key could only be named by the rule's text or by its position,
so a grader edited from three rules to two would leave the third rule's row
behind, speaking forever, with no later grading able to supersede it. And a rule
shelf is one policy: "these tools must fire and this one must never" is one thing
a team decided, so two thirds of it is not a pass and a score of 0.67 would say
it was. The granularity a developer needs lives where they will actually read it,
in the rationale.

The built-in behaviors grader is the exception, and it earns it: its rows are
filed under the **frozen test version** the conversation was executed against,
which never changes for that conversation, so a position means the same sentence
forever.

**`tool_calls` reads the observed calls and never the transcript.** An agent that
*says* it looked up the booking and did not is exactly the failure this check
exists to catch, and a check that read the sentence would agree with it. An
argument constraint is a constraint on the call rather than a description of it:
every named argument must be there with that value, and anything else the agent
sent alongside is ignored. A platform that reports the invocation and not its
arguments leaves a constraint unshown rather than unmet, and the rationale says
which.

**`phrase_match` searches the agent's turns by default.** The agent is what is
under test; the persona is egma's own synthetic caller, and judging what egma
made it say would be judging egma. A grader may name `persona` or `either`
deliberately. `contains` is looked for as written and case-insensitively — a
disclosure read back in a different case is the disclosure — and `regex` means
exactly what its author wrote. A pattern that will not compile is `errored` and
never `failed`: marking an agent down for egma's own broken config is the one
thing a test product must never do.

**`llm_rubric` is one rubric, one call, one row.** The config holds one block of
criteria text, so it asks one question; a grader that wants two things decided
separately is two graders, which gives two rows a developer can read apart.
Splitting one rubric's text on whatever punctuation looked like a list would
invent criteria nobody wrote.

## The measure catalog

A `metric_threshold` grader names the measure it reads as a string, and a string
that names nothing produces a grader that reads nothing, judges nothing, and is
`skipped` forever. The **measure catalog** —
`packages/simulation-contract/measure-catalog.md`, beside the two schemas, with
`src/measures.ts` as the same list in code — names every measure a simulation
produces and the aggregations a threshold may ask of them. The grader factory's
write door refuses a measure that is not in it, naming the catalog, so a typo is
a refusal at the moment it is written rather than a check that quietly never
fires.

## The built-in: a test's expected behaviors, judged one at a time

Every test is judged against its own expected behaviors, always. The built-in
grader that does it is never attached, never detached, and never a row in any
table — applying it is part of what running a test means, so a test can never be
made unfalsifiable.

**One independent judge call per behavior**, all in parallel, each producing its
own verdict row. The alternative — one call that reads the whole list — gives a
developer one blurred explanation and lets a judge trade a failed behavior off
against a passed one. Here each row names the behavior's position
(`behavior_1`, `behavior_2`, …) in the order the author wrote them — the key,
never the sentence, which a reader gets back from the pinned test version.

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

A judge is the project's: **provider, model, and a key held in the encrypted
credential store**, set once per project and overridable per grader (a grader
version may name its own provider and model — never its own key, so no grader
can move a project's judging onto an account nobody configured).

v1 ships the OpenAI provider and nothing else, behind a provider-shaped seam: a
second provider is a second file plus a line in one roster. Requests go to
`https://api.openai.com/v1/chat/completions` — one POST, one JSON body, one JSON
answer, no SDK.

**The key is read once per conversation, handed to one `fetch`, and written
nowhere.** It is not in a verdict row, not in a log line, not in a rationale, and
not in what a refusal says. A verdict names the judge as `openai/<model>`, which
is what "which judge said this" needs and all it needs.

A project that configured no judge still runs every deterministic grader it has;
its judged checks come back `errored` saying so, never quietly green.

## Configuration

Everything arrives as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Where conversations, graders and tests are read from. |
| `CLICKHOUSE_URL` | (required) | Where verdicts are written. |
| `EGMA_ENCRYPTION_KEY` | (unset) | What a project's judge key was sealed with. Only needed once a project configures a judge. |
| `EGMA_GRADER_CLAIMANT` | `grader-<host>-<pid>` | The name stamped on claims. |
| `EGMA_GRADER_CAPACITY` | `4` | Most conversations judged at once. |
| `EGMA_GRADER_HEARTBEAT_SECONDS` | `15` | How often a copy says it still holds a job. |
| `EGMA_GRADER_LEASE_SECONDS` | `120` | How long a claim survives a copy's silence. Must be well above the heartbeat. |
| `EGMA_GRADER_SWEEP_SECONDS` | `30` | The backstop, not the trigger — see below. |
| `EGMA_GRADER_TRACE_IDLE_SECONDS` | `300` | How long a production conversation must be quiet before it is judged without ever having been closed. |
| `EGMA_GRADER_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN` or `ERROR`. |

`EGMA_ENCRYPTION_KEY` is the same key the API seals with, and it is here because
a judged grader replays the project's own judge key to the provider — the
process making that call has to be able to open the envelope. What it can open
is narrowed on the other side rather than by withholding the key: a judge key
resolves only for a context built from a grading claim, and a connection's
credentials sit behind a door asking for a permission the engine's context does
not carry.

It is optional, and its absence is an ordinary deployment: a project that
configured no judge never opens an envelope. A project that did, on a grader
given no key, gets `errored` verdicts saying the key could not be read — never a
service that will not start, and never a silent pass.

There is deliberately **no model key** here, and that one stays absent. A judge
configured per container would be a judge no project chose, spending an account
no project named. The judge belongs to the project.

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

## Adding a grader type

One file, one line. `src/graders/contract.ts` says what every type is handed and
what every one of them answers with; write a module that exports a function of
that shape and name it in the roster in `src/graders/index.ts`. Nothing else
changes — the claim, the read, the resolution, the verdict rows and the fold are
all written once, in the grader's vocabulary rather than in any type's.

A type that is named and has no executor yet answers `errored` rather than
saying nothing, because a page that goes green because a check quietly judged
nothing is the exact false trust this product exists to kill.

A type that judges with a model asks for one through the `judging` it is handed.
Every executor gets one, including the deterministic ones, and the deterministic
ones simply never call it — resolving a judge is what unseals a project's key, so
a conversation whose graders are all deterministic never opens the envelope
however many of them were handed the seam.

```ts
const resolved = await execution.judging.judge();
if (resolved instanceof NoJudge) return errored(resolved.message);

const judge = resolved.judging(execution.judging.model, execution.judging.makers);
const answer = await judge.ask({ criterion, evidence: judgeInputOf(conversation) });
```

`judge` reads the project's configuration and unseals its key at most once per
conversation, however many graders ask. `model` is this grader version's own
`judge_model` — its override, or `null` for the project's default; the built-in
behaviors grader passes `null`, because it is nobody's to configure.

What `judging(…)` answers with is two things and no more: **`ask`**, a function
that decides one criterion, and **`name`**, the `provider/model` string that says
which judge answered. The key is not on that pair, and that is the point:
nothing under `src/graders/` can reach one, so no grader type — today's or
tomorrow's — can put a key in a rationale, a row or a log.

**The verdict row does not record which judge answered.** `judged_by` retired
with the human corrections it existed for: a person's word returns as the
reserved `human` grader type, writing its own rows under its own grader id, so
the column had nothing left to keep apart.

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
