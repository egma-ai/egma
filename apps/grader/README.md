# The grader

The service that judges finished conversations — the same graders, both sources.
A simulation reaching its terminal transition becomes claimable work in the same
commit that lands it; a production conversation becomes claimable when its
telemetry says it is over. This service takes the work, reads the conversation,
resolves the graders that apply to it, executes each one, and writes a verdict
row per judged dimension.

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
   conversation was executed against. A grader named by both is one grader. For
   a production conversation: the project's graders whose scope includes
   production, and nothing else — a real caller is in nobody's scenario, so no
   test's grader array reaches here and the built-in has no expected behaviors
   to judge against. Each of those graders is then asked whether this
   conversation is its turn, which is what the sampling rate decides.
4. **Execute.** One function per grader type, behind one seam. `metric_threshold`
   reads a measure off the conversation and applies an aggregation, a comparator
   and a threshold — in-process, no model, the same answer every time.
5. **Write.** One row per judged dimension: the verdict word, a score, a
   one-line rationale, the spans it cites, and the grader's priority as it stood
   at that moment. **No overall row is written anywhere** — a conversation's
   answer and a run's are folded from these rows at read time, so a headline can
   never disagree with the evidence under it.

Two rules run through all of it. **A simulation that never ran is `errored` for
every grader and never `failed`** — a broken test is not a broken agent. And **a
check that could not be made says so**: a measure this conversation does not
have is `skipped` and leaves the score's denominator; a measure recorded in a
shape egma never writes is `errored`, because a corrupted row and a missing one
are different facts.

## Configuration

Everything arrives as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Where conversations, graders and tests are read from. |
| `CLICKHOUSE_URL` | (required) | Where verdicts are written. |
| `EGMA_GRADER_CLAIMANT` | `grader-<host>-<pid>` | The name stamped on claims. |
| `EGMA_GRADER_CAPACITY` | `4` | Most conversations judged at once. |
| `EGMA_GRADER_HEARTBEAT_SECONDS` | `15` | How often a copy says it still holds a job. |
| `EGMA_GRADER_LEASE_SECONDS` | `120` | How long a claim survives a copy's silence. Must be well above the heartbeat. |
| `EGMA_GRADER_SWEEP_SECONDS` | `30` | The backstop, not the trigger — see below. |
| `EGMA_GRADER_TRACE_IDLE_SECONDS` | `300` | How long a production conversation must be quiet before it is judged without ever having been closed. |
| `EGMA_GRADER_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN` or `ERROR`. |

There is deliberately no encryption key here. Grading reads conversations,
graders and test versions and writes verdicts; it never touches a connection's
credentials, so it is never handed the key that could unseal one.

There is deliberately no model key either. The grader types v1 executes are
deterministic and judge in-process. A judge model belongs to the project that
configured it rather than to a container.

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

## Tests

```
pnpm db:up          # Postgres and ClickHouse, once
npx vitest run apps/grader
```

Both stores are real. Everything worth asserting here is one of their
behaviours: the notification a transaction raises, the lock that keeps two
copies off one conversation, and the store's identity collapsing a second
judgment onto the one it repeats rather than filing it beside it. No test needs
a model key, because nothing under them does.
