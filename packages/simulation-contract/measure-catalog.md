# The measure catalog

**Catalog version: 1**

Every measure a simulation produces, named once, so that a `metric_threshold`
grader references a known measure instead of guessing a string.

This is a contract document, not a table. Nothing writes a row to declare a
measure and nothing queries for the list. It sits beside `schemas/` because it
is the same kind of fact those two schemas are: what the simulator emits, agreed
between the control plane and the simulator, versioned so that neither side can
change it quietly.

`src/measures.ts` is this document as a constant. The two are held to each other
by the contract test suite, and that suite also reads the simulator's own source
— so a measure emitted in Python and missing here fails the build's tests rather
than surfacing months later as a grader nobody noticed was silent.

## Why it exists

A threshold grader names what it reads as a string, and a string that names
nothing produces a grader that reads nothing, judges nothing, and is `skipped`
forever: green, silent, and wrong. Nothing downstream can catch it. A missing
measure is a perfectly legitimate `skipped` — a chat conversation has no audio
band to threshold — so the grading engine has no way to tell a typo from a
modality. Only the moment of writing can, which is why the grader factory's
write door refuses a measure this catalog does not name.

## The measures

`Taken` says how many numbers one simulation produces. `once` is one number for
the whole conversation. `per_turn` is a series, one sample per turn, which is
what makes a percentile mean something.

`Arrives as` says where the number comes from on the wire, which is not the same
question as what it is called here. A **timing event** is its own report event,
one per measurement, carrying exactly the name in this table. A **terminal
fact** arrives on the status transition that ends the simulation, inside its
facts, and the control plane records it under the catalog name — so a threshold
grader reads one vocabulary whether the number was timed or counted.

| Measure | Unit | Taken | Emitted by | Arrives as | What it is |
| --- | --- | --- | --- | --- | --- |
| `first_response_latency` | milliseconds | once | every simulation | timing event | How long the agent took to say anything at all, from the moment the simulation began. |
| `turn_response_latency` | milliseconds | per turn | every simulation | timing event | How long the agent took to answer, measured once for every turn the persona took. |
| `time_to_first_word` | milliseconds | per turn | voice simulations | timing event | The quiet before the agent's first word of an answer, measured out of the audio rather than off a clock. |
| `agent_speech_duration` | milliseconds | per turn | voice simulations | timing event | How long the agent spoke for, silence inside the answer excluded. |
| `persona_speech_duration` | milliseconds | per turn | voice simulations | timing event | How long egma's own synthetic caller spoke for — what the agent was made to listen to, not anything the agent did. |
| `turn_count` | turns | once | every simulation | terminal fact | How many transcript turns the conversation reached, both speakers counted. |
| `measured_audio_band_hertz` | hertz | once | voice simulations | terminal fact | The sample rate the simulator actually heard, negotiated or measured and never copied from configuration. |

A voice-only measure on a chat conversation is not a failure and not an error.
The conversation did not produce the thing the check is about, so the check did
not apply: the verdict is `skipped` and it leaves the score's denominator. That
is what stops a chat simulation being marked down for having no audio.

The same is true of a measure no conversation carries yet. This table is the
contract the report fold honors, and it is written down first on purpose: a
grader written against a measure the fold has not started recording is `skipped`
until it does, which is an honest "not measured here" rather than a silent pass.

## The aggregations

A threshold reduces a measure to one number and compares it. Every measure in
this catalog accepts all eight reductions:

| Aggregation | What it answers |
| --- | --- |
| `mean` | The average of the samples. |
| `sum` | All of them added up. |
| `min` | The smallest. |
| `max` | The largest. |
| `p50` | The median, nearest-rank. |
| `p90` | The 90th percentile, nearest-rank. |
| `p95` | The 95th percentile, nearest-rank. |
| `p99` | The 99th percentile, nearest-rank. |

Percentiles are **nearest-rank**: the p90 of ten measurements is the ninth of
them, not an interpolation between the ninth and the tenth. Nearest-rank is a
measurement that actually happened, which is what somebody reading "p90 was
1800ms" expects to be able to find in the transcript.

A measure taken once answers the same number to all eight, because every
reduction of one sample is that sample. Naming `max` or `mean` on
`first_response_latency` is therefore a matter of taste rather than a different
question, and both are accepted.

A latency check almost always wants a percentile. A mean hides the one turn that
took nine seconds, which is the turn the caller hung up on.

The list is stated per measure in `src/measures.ts` rather than once for all of
them, so that the day a measure arrives which must never be summed — a rate, a
percentage — the refusal lives in the catalog beside that measure rather than in
a rule somebody has to remember.

## What is deliberately not here

- **Verdicts.** A metric measures and a grader judges. Nothing in this catalog
  decides whether a number is good; a `metric_threshold` grader is somebody
  deciding that, written down, and it is the only thing that turns a measurement
  into a judgment.
- **Measures a customer defines.** The catalog ships as egma's own contract. A
  team that wants a number egma does not measure is asking for a feature, and
  the honest answer today is that the list is this one.
- **Anything read from a span.** Production conversations arrive through the
  OTLP door and carry their own attributes. When threshold grading reaches them,
  what they measure joins this document under the same discipline — named,
  versioned, and refused at the write door until it is.

## Changing this catalog

Bump the version when a measure joins, leaves, or changes what it means, and
change `MEASURE_CATALOG_VERSION` in `src/measures.ts` in the same commit.

A measure that leaves needs more than a deletion. Graders already stored against
it keep naming it, and they keep reading: the write door guards new writes and
never rewrites history, so an old grader whose measure is gone becomes a check
that is `skipped` forever — exactly the silence this catalog exists to prevent.
So a removal is a decision about the graders that name it, taken deliberately,
and not a line struck out of a table.
