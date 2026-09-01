# The measure catalog

**Catalog version: 7**

Every metric a conversation produces, named once and defined once, so that a
grader references a known metric instead of guessing a string — and so that the
number Egma shows and the number a grader reads use the same arithmetic.

This is a contract document, not a table. Nothing writes a row to declare a
measure and nothing queries for the list. It sits beside `schemas/` because it
is the same kind of fact those two schemas are: what Egma measures, agreed
between the control plane and the simulator, versioned so that neither side can
change it quietly.

`src/measures.ts` is this document as a constant. The two are held to each other
by the contract test suite, and that suite also reads the simulator's own source
— so a measure emitted in Python and missing here fails the build's tests rather
than surfacing months later as a grader nobody noticed was silent.

## Why it exists

A grader definition can name what it reads as a string. A string that names
nothing makes that definition impossible to execute honestly. Only the write
door can tell a typo from a metric that is legitimately absent on one trace, so
it refuses a metric this catalog does not name. There is no synthetic `skipped`
grade: incompatible modality prevents selection, while missing evidence for a
selected grader produces a grading error and no score.

The same argument, one level down, is why each measure now carries its
**span-level definition**. A name says what may be asked for; the definition
beside it says what Egma computes when asked. One shared measure module
implements exactly the definitions below, the **Use** form offers exactly the
measures that have one, and the write door accepts exactly the same list — so a
developer cannot pick a metric nothing can answer, and the number on the metrics
display cannot come out differently from the number a grader reads.

## The measures

`Taken` says how many numbers one simulation produces. `once` is one number for
the whole conversation. `per_turn` is a series, one sample per turn, which is
what makes a percentile mean something.

`Arrives as` says where the number comes from on the wire, which is not the same
question as what it is called here. A **timing span** is its own span through
the trace store's ingest, one per measurement, named for exactly the name in
this table, and the span's own duration *is* the number — nothing carries it a
second time. A **terminal fact** arrives on the status transition that ends the
simulation, inside its facts, and the control plane records it under the catalog
name — so every display or future grader reads one vocabulary whether the
number was timed or counted.

| Measure | Unit | Taken | Emitted by | Arrives as | What it is |
| --- | --- | --- | --- | --- | --- |
| `first_response_latency` | milliseconds | once | every simulation | timing span | How long the agent took to say anything at all, from the moment the simulation began. |
| `turn_response_latency` | milliseconds | per turn | every simulation | timing span | How long the agent took to answer: from the persona's turn going out to the agent beginning its answer. One sample per persona turn the agent began answering; a turn it never began answering takes none. |
| `time_to_first_word` | milliseconds | per turn | voice simulations | timing span | The quiet before the agent's first word of an answer, measured out of the audio rather than off a clock. |
| `agent_speech_duration` | milliseconds | per turn | voice simulations | timing span | How long the agent spoke for, silence inside the answer excluded. |
| `persona_speech_duration` | milliseconds | per turn | voice simulations | timing span | How long Egma's own synthetic caller spoke for — what the agent was made to listen to, not anything the agent did. |
| `asr_latency` | milliseconds | per turn | the agent's platform | the platform's own telemetry | How long the agent's platform spent turning the caller's speech into text, by the platform's own account. |
| `llm_latency` | milliseconds | per turn | the agent's platform | the platform's own telemetry | How long the agent's platform spent thinking — the language-model step of an answer, by the platform's own account. |
| `tts_latency` | milliseconds | per turn | the agent's platform | the platform's own telemetry | How long the agent's platform spent turning the answer's text into speech, by the platform's own account. |
| `turn_count` | turns | once | every simulation | terminal fact | How many transcript turns the conversation reached, both speakers counted. |

A metric is an observed fact, not a grade. A chat conversation therefore has no
voice-only metric; Egma does not invent a zero or create a `skipped` grade. Grader
definitions separately declare compatible modalities. A voice-only grader is
not selected for a chat trace, so it creates no plan item and no grade row.

This table is the contract the shared measure module honors. A future grader
that needs one of these metrics must state how absence affects its own score or
error result. The metric layer does not make that quality decision.

## How each measure is computed from the spans

One shared measure module reads a trace and computes every measure below. It is
the **only** computation path for them: the metrics display reads through it and
so does the grader, for a simulation and for a production trace alike — so
identical spans produce identical numbers whatever conducted the conversation,
and the number on the screen and the number a grader reads cannot disagree.

Each definition names a **rule**, and the rules are a closed list the module
switches on exhaustively. A rule nothing implements stops the build.

| Measure | Rule | Computed from the trace as |
| --- | --- | --- |
| `first_response_latency` | `timing_spans_named_for_it` | Every span named `first_response_latency`; each span's own duration is one sample. |
| `turn_response_latency` | `timing_spans_named_for_it` | Every span named `turn_response_latency`; each span's own duration is one sample. |
| `time_to_first_word` | `timing_spans_named_for_it` | Every span named `time_to_first_word`; each span's own duration is one sample. |
| `agent_speech_duration` | `timing_spans_named_for_it` | Every span named `agent_speech_duration`; each span's own duration is one sample. |
| `persona_speech_duration` | `timing_spans_named_for_it` | Every span named `persona_speech_duration`; each span's own duration is one sample. |
| `asr_latency` | `platform_telemetry_carries_it` | Never egma's own timing span. Reported per call by Retell (its `asr` stage); no recognised framework span carries it today, so it is never derived. |
| `llm_latency` | `platform_telemetry_carries_it` | Never egma's own timing span. Derived as the sum of a `turn:agent` span's own `model` children per turn, or read from the platform's reported `llm` stage. |
| `tts_latency` | `platform_telemetry_carries_it` | Never egma's own timing span. Derived as the sum of a `turn:agent` span's own `tts` children per turn, or read from the platform's reported `tts` stage. |
| `turn_count` | `no_span_carries_it` | Nothing. The simulator counts the turns it conducted and reports the total on the terminal transition, where the simulation row keeps it. |

A timing span's duration **is** the measurement — nanoseconds on the wire,
milliseconds here, and nothing carries the number a second time for the two to
disagree about. Samples come back in the order the measurements were taken, so a
per-turn series reads forwards and two readings of one conversation reduce the
same list.

**A measure with the rule `no_span_carries_it` may not be named by a grader**,
and the write door refuses it. `turn_count` already arrives on the terminal
transition and is read back off the simulation row; deriving it a second time
from the spans would be a second answer about one simulation. The turn spans
could be counted, and they are deliberately not.

## Derived measures: a framework's own spans, read as these numbers

A **derived** measure is one Egma works out from a framework's own spans rather
than reading off a timing span named for it. It is a fact about one
conversation, not a new measure and not a new word: the same names below are
timed on a simulation and derived on a stock LiveKit call or a word-bounded
Retell one, and a grader bounding one never has to know which it got.

Why they exist: a stock LiveKit agent initially produced no values for these
metrics because the framework times its turns in its own vocabulary and Egma
read only its own. The durations were there the whole time. The same was true
of Retell twice over: its payloads carry per-word `start` and `end` bounds on
every spoken turn, which the normalizer has written as real turn timestamps
since commit `cc7b8c9` — and the derivations then ignored the root because it
is filed as `conversation` rather than `root`, so `first_response_latency` was
never computed there either.

Three rules hold over all of them.

- **Recognition rides the door's vetting, never a span name.** The OTLP door
  assigns `turn:human`, `turn:agent` and `speaking` from a table keyed by the
  emitting instrumentation scope, and the Retell normalizer assigns them to the
  turns it built itself; a scope the door does not know is filed as `other`,
  whatever its spans are called. So the kinds below are already evidence that
  Egma recognised the emitter, and a lookalike span from some other framework
  becomes nothing. **The root is not recognised by kind at all**: a root wears
  whatever word its platform uses — `root` on Egma's own traces and LiveKit's,
  `conversation` on a Retell one — so the derivations find it the way the trace
  read does, by the empty parent.
- **Egma's own timing vocabulary wins absolutely.** When a conversation carries
  timing spans for a measure, no derivation for that measure runs. A
  conversation carrying both has one answer, never two appended.
- **A measurement that runs backwards is not kept.** Turn spans overlap on a
  real captured call — five of twelve neighbouring pairs — and the overlap is
  the framework's turn bookkeeping, not audible talk-over: the same call's
  speaking spans carry zero seconds of simultaneous audio
  (`research/voice-agent-interruption-metrics.md`, planning root). A negative
  latency would drag a mean below zero and pass a bound that should have
  failed, so the overlapping pair contributes nothing.

Derived at read time. Nothing new is stored, and every conversation already in
the store gains these on the next read.

| Measure | Derived from recognised turn spans as | Taken |
| --- | --- | --- |
| `turn_response_latency` | From each `turn:human` span's **end** to the first later `turn:agent` span's first `speaking` child, before another human turn begins. A silent agent turn on the way is model or tool work, not the spoken answer. Where the entire conversation carries no `speaking` spans, the first agent turn's own start stands in for a framework that records only word-bounded turns. **An agent answer belongs only to the nearest human turn before it: a human turn followed by another human turn before any agent speech was not answered, and measures nothing.** | One sample per human turn, in conversation order. A human turn nobody answered, one the caller spoke over with a second turn, and one whose sample runs backwards contribute none. |
| `first_response_latency` | From the root span's start — the earliest parentless span — to the first `turn:agent` span's first `speaking` child's start. Where the conversation carries no `speaking` spans at all, the first agent turn's own start stands in — a word-bounded Retell turn begins at its first word; a framework that does write speech makes a speechless first turn unmeasurable. A first agent turn with neither speech nor width measures nothing. | Once. |
| `agent_speech_duration` | The sum of a `turn:agent` span's own `speaking` children's durations — so a turn that thought for two seconds and then talked for one spoke for one. | One sample per agent turn **that spoke**. A turn with no speech in it has no speech duration; a zero would measure something that never happened. |
| `llm_latency` | The sum of a `turn:agent` span's own `model` children's durations — LiveKit's `llm_node`/`llm_request` family, as the door files it — so a turn whose model was asked twice accounts for both askings. | One sample per agent turn that carried a model step. A turn with none has no model latency; a zero would measure something that never happened. |
| `tts_latency` | The sum of a `turn:agent` span's own `tts` children's durations — LiveKit's `tts_node`/`tts_request` family, as the door files it. | One sample per agent turn that carried a synthesis step. Same absence rule as the model step. |

Each sample cites the span its number came from: the span whose start closed the
interval for a latency, and the turn itself for a duration summed over its
children.

**Two measures are deliberately not derived.**

- `time_to_first_word` — defined out of audio Egma does not hold for production
  traffic.
- `persona_speech_duration` — Egma's synthetic caller is not in a production
  conversation, so the measure has no production meaning.

**The Retell derivations were checked against Retell's own ruler** on a live
production call (2026-08-22): the word-bound gaps Egma derives — 2218 ms,
2557 ms, 3325 ms — matched Retell's own reported `e2e` values exactly where
both measured (2218, 2557), and caught a third answered turn Retell's list
missed. That is why a derived measure keeps precedence over a reported one:
same ruler, more coverage. A Retell turn with no word bounds — and every turn
stored before commit `cc7b8c9` — is a zero-width placeholder; a conversation
of those derives nothing and answers from the reported block instead.

Every other framework derives nothing until an effort of its own teaches this
document its shapes.

**Nothing is derived from the shape of the transcript alone**, on either source
— which is what the `speaking` children above are for. The obvious shortcut, the
gap between one turn ending and the next beginning, comes out negative on a real
captured conversation. A number that is wrong is worse than a measure that is
missing, so a metric the spans do not carry is absent. A selected grader that
requires that evidence must return a grading error and no score.

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

All eight are implemented by the shared measure module (`aggregateOf`), whose
switch is exhaustive over this list — a name joining it without a case stops
the build. The conversation reads carry `mean`, `p50` and `p90` on the wire;
the product currently leads with the p90, and which reduction a surface shows
is that surface's decision, never new arithmetic.

The list is stated per measure in `src/measures.ts` rather than once for all of
them, so that the day a measure arrives which must never be summed — a rate, a
percentage — the refusal lives in the catalog beside that measure rather than in
a rule somebody has to remember.

## What is deliberately not here

- **Grades.** A metric records an observed fact and a grader assigns a score.
  Nothing in this catalog decides whether a number is good. A future grader can
  compare a metric with its own rule, but that rule belongs to the grader.
- **Measures a customer defines.** The catalog ships as Egma's own contract. A
  team that wants a number Egma does not measure is asking for a feature, and
  the honest answer today is that the list is this one.
- **A provider's own latency attributes.** A real caller's telemetry arrives
  through the same OTLP door carrying the agent's own numbers — LiveKit puts an
  end-to-end turn latency on `lk.e2e_latency`, inside the verbatim payload the
  trace read deliberately does not return. Reading one is a decision for the
  ingest door, normalised once for every provider into a shape this catalog
  already names — which is exactly how the stage latencies arrived at version
  5: Retell's `asr`/`llm`/`tts` stages land in the reported block under
  catalog names, LiveKit's stage spans land as `model`/`tts` kinds the
  derivations read, and a measure module that parsed provider attributes
  itself would still be a second normaliser and still does not exist.
  Retell's knowledge-base stage stays platform-prefixed
  (`retell/knowledge_base_latency`): retrieval is Retell's own concept, not a
  stage every platform has. A production trace otherwise carries exactly the
  metrics its telemetry carries. A selected grader that requires missing
  evidence returns a grading error and no score.

## Changing this catalog

Bump the version when a measure joins, leaves, or changes what it means — a
span-level definition changing is a measure changing what it means — and change
`MEASURE_CATALOG_VERSION` in `src/measures.ts` in the same commit.

A metric that leaves needs more than a deletion. Immutable grader definition
versions can still name it, and the write door never rewrites history. Removing
the metric therefore requires a deliberate migration or retirement decision for
those definitions; it is not only a line struck out of a table.
