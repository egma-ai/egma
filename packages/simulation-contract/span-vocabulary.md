# The span vocabulary

**Contract version: 1**

Every Egma-authored span the simulator emits, named once, so that the emitter
and the platform's OTLP ingest agree on the same shapes and neither can change
them quietly. Pipecat-native service spans keep Pipecat's own vocabulary and
instrumentation scope.

This is a contract document, not a schema. On the wire a conversation is an
ordinary OpenTelemetry `ExportTraceServiceRequest`, posted at the same ingest
door a customer's agent posts to — that is the point of speaking OTLP at all.
What this document pins down is the part OTLP leaves open: what the spans are
called, which attributes carry the conversation, and how a batch names the
simulation it is evidence of. It sits beside `measure-catalog.md` because it is
the same kind of fact: what the simulator emits, agreed between the simulator
and the control plane, versioned so drift breaks a build instead of a customer.

The golden fixtures under `fixtures/spans/` are worked OTLP examples. The
`valid/` files are flushes of real conversations — the simulator emits these
vocabularies and relationships with SDK-minted span ids, and the ingest's own
suite posts these files and asserts what lands. The `invalid/` file is the one
refusal the ingest makes at the batch grain: a resource that names no
simulation. Both suites read the same files, which is what keeps the two sides
from drifting apart silently.

## How a batch names its simulation

Every OTLP resource in a batch carries one resource attribute:

| Resource attribute | Value |
| --- | --- |
| `egma.simulation_id` | The simulation this telemetry is evidence of, echoed verbatim from the claimed spec. Opaque to the simulator: never parsed, never minted, never rewritten. |

The ingest resolves the organization, the project and the run from the
simulation row on the platform's own side — a resource attribute claiming a
tenant is stored in the payload like any other attribute and never consulted.
A resource naming no simulation, or naming one the deployment never conducted,
refuses the whole request; there is nowhere honest to file it.

`service.name` is carried too, because that is what a well-formed
OpenTelemetry resource does. It decides nothing.

## Trace identity

The simulator deterministically derives the trace id from the simulation id,
so the simulation row, its spans, and its trace-level grades can find each
other:

- **trace id** — the simulation id's own 128 bits: the 26 Crockford base32
  characters after `sim_` decoded to a 128-bit integer, written as 32 lowercase
  hex characters. `sim_01K3XQ7M4E8YB2FVN0H9TZQWER` is trace
  `0198fb73d08e479627eea08a75fbf1d8`, always. OpenTelemetry reserves the
  all-zero trace id as invalid, so the simulator refuses the otherwise
  well-shaped all-zero simulation id before it reports the simulation as
  running.
- **span ids** — minted by the OpenTelemetry SDK when the span is authored and
  unique within the trace. A retry replays the already-serialized bytes, ids
  and timestamps included. A new execution, even of the same words, receives
  new span ids and is retained as new evidence.

## The instrumentation scope

Every Egma-authored span rides the scope named **`egma-simulator`**. Pipecat's
native service spans keep Pipecat's own scope, names, status, events, links, and
attributes. The ingest recognises transcript vocabulary by the Egma scope,
never by span names alone — a framework span that happens to call itself
`agent_turn` is not a transcript line.

## The spans

A span is one timed thing inside the conversation. Timestamps are stamped when
the thing happened and replayed byte-identically on resends — never re-derived
at send time. Shapes permit overlap: two turns may cross in time, which is how
barge-in is represented when the persona becomes full-duplex, and
`voice-overlapping-turns.json` shows a pair doing it.

| Span name | One per | Duration | Attributes |
| --- | --- | --- | --- |
| `simulation` | conversation | The whole conversation. The root: it names no parent, every other span names it, and it is emitted last — when it arrives, the conversation is over and every other span is already on the wire. | none |
| `recording` | stored voice recording | Zero. Its start is audio sample zero on the same clock used by spoken turns. It is emitted only after the WAV is stored, before the root closes. | none |
| `human_turn` | transcript turn spoken by the persona | The turn, ear to ear. Zero on chat, where a message is one instant. | `egma.turn.text` |
| `agent_turn` | transcript turn spoken by the agent under test | Same terms as `human_turn`. | `egma.turn.text` |
| `tool_call` | tool call observed from Egma's side of the connection | One instant where the platform reports the invocation and nothing more. Where Egma stood in the tool path — answering the call or refusing it — the span brackets the exchange Egma conducted, the round trip plus any delay the mock tool declared, so a declared delay is readable as the time it actually took and no attribute repeats the number for the two to disagree about. | `egma.tool.name`, `egma.tool.arguments`, `egma.tool.result`, `egma.tool.provenance`, `egma.tool.mock_tool`, `egma.tool.late_attached` |
| *measure name* | measurement | **The measurement itself.** A timing span is named for the measure it takes — `first_response_latency`, `turn_response_latency`, `time_to_first_word`, `agent_speech_duration`, `persona_speech_duration` — and its start and end bracket the measured interval, so the span's duration *is* the number, in nanoseconds. The catalog (`measure-catalog.md`) says what each measure means and who emits it. | none |

The speaker of a turn rides the span name — `human_turn` and `agent_turn` are
the transcript's two labels, exactly — so there is no second field free to
disagree with it.

## The attributes

| Attribute | On | Value |
| --- | --- | --- |
| `egma.turn.text` | `human_turn`, `agent_turn` | What was said, as text — spoken and transcribed on voice, sent verbatim on chat. May be empty for a turn that carried no words. |
| `egma.turn.platform_notes` | `agent_turn` | What the agent's platform said about the turn that nobody said *in* it — a node transition it announced mid-answer, a message in a role Egma has never seen. A JSON array of strings, in the order the platform said them, and absent for every turn that has none, which is nearly all of them. It rides beside `egma.turn.text` rather than inside it because the turn's text is handed back to the persona as the transcript it answers, and because one scenario's chat and voice records are only comparable while neither carries words nobody spoke. Only a connection whose platform reports such things ever emits it. |
| `egma.tool.name` | `tool_call` | The tool's name, exactly as the platform reported it. |
| `egma.tool.arguments` | `tool_call` | The arguments, JSON-encoded, exactly as observed — absent where the platform reports the invocation but not its arguments. A string deliberately: the observed bytes are the fact worth keeping. |
| `egma.tool.result` | `tool_call` | The answer the call was given, JSON-encoded, exactly as it was served. Present only where Egma itself authored the answer; absent for a call Egma merely watched go past, and absent for one Egma refused. |
| `egma.tool.provenance` | `tool_call` | How the call was answered. Two values: `mocked` — a mock tool answered, and Egma served it; `refused` — Egma was asked and would not answer, so nothing ran. Absent means the call was observed and not answered, which is every call on a connection Egma is not in the path of. |
| `egma.tool.mock_tool` | `tool_call` | The mock tool that answered, by name. Present only beside `mocked`. |
| `egma.tool.late_attached` | `tool_call` | A genuine boolean, `true` only where the call was served for a tool the agent had not reported having when the simulation started. Absent elsewhere: a stamp for the ordinary case would ride every span, and a call nothing served has nothing to qualify. |

**Why a result may be recorded at all.** The rule it looks like an exception to
— never record half an exchange nobody observed — is about *the agent's* return
values, which Egma does not see. An answer Egma itself served is not observed,
it is authored: recording it invents nothing, and a served answer with the
served half missing would be the dishonest record. So the result attribute
appears only beside `mocked`, and a call Egma only watched go past carries
neither it nor a stamp.

**Why a refusal is a stamp and not an absence.** Egma tells the agent's side
exactly which tool names it answers for. A call for any other name is that side
asking for something it was never offered, and Egma refuses it on the wire
rather than waving it through — so no backend runs, and no answer is served.
The three shapes are three different histories and each gets its own:

| Shape | What happened |
| --- | --- |
| name, arguments, result, `provenance: mocked`, `mock_tool` | Egma stood in the path and answered. The backend was never touched. |
| name, arguments, `provenance: refused` | Egma stood in the path and would not answer. The backend was never touched, and the agent was told so. |
| name, arguments, and nothing else | Egma was not in the path. The real tool ran, and Egma saw only that it was called. |

Written the same way, the second and third would be indistinguishable — and
they are opposite facts about whether the agent's own backend ran. The whole
point of the coverage stamp on the simulation's terminal facts is that a reader
can tell an isolated simulation from one that was not; a refusal that read as a
pass-through would undo that at the call grain.

**Why the tool's name and the mock tool's name are both written down.**
`egma.tool.name` is the agent's word — what the platform reported being called.
`egma.tool.mock_tool` is Egma's own — the authored thing that answered. Today
they always match, because a mock tool is matched to a call by name and by
nothing else; writing both is what makes the day they stop matching visible on
the record instead of assumed away.

**What `late_attached` owns.** When a simulation starts, the agent reports the
tools it has. Answers are then held ready for every tool name this simulation
covers, whether or not that first report named it, so an agent that gains a
tool afterwards still has that tool answered rather than reaching a real
backend — the safe way round. What such a call cannot promise is its arguments:
with no tool of the agent's own to take the shape of, what arrives may be
trimmed or missing altogether. The flag carries that caveat, so a reader never
takes thin arguments for an agent that passed none.

## What the fixtures show

- `chat-flush-1-turns.json`, `chat-flush-2-tools.json`,
  `chat-flush-3-root.json` — one chat conversation as the three flushes the
  simulator sends as its Egma-authored record: turns and a first-response
  measurement while the conversation runs, tool calls and a per-turn
  measurement as they happen, and the closing turn with the root last. Together
  they are the whole trace. ClickHouse suppresses a recent byte-identical
  block. Changed, regrouped, or reordered content is a different block and is
  retained even when span ids repeat; the reader never collapses stored rows by
  span id.
- `voice-overlapping-turns.json` — a mid-conversation voice flush where the
  persona starts speaking before the agent finishes: two turns whose intervals
  cross, with the two speech-duration measures beside them.
- `voice-flush-recording-root.json` — a closing voice flush: the zero-duration
  recording span places audio sample zero on the trace clock, followed by the
  root last.
- `voice-mocked-tool-calls.json` — a mid-conversation flush of three calls that
  reached Egma: an ordinary mocked call, arguments whole and its 250 ms of
  declared delay showing as the span's duration; a late-attached one whose
  arguments never arrived; and one for a tool this simulation answers for
  nothing of, refused on the wire and stamped `refused` on the record. Beside
  `chat-flush-2-tools.json`, whose calls carry name and arguments and nothing
  else because Egma was not in that path at all, it is the whole range this
  span shape covers.
- `invalid/resource-naming-no-simulation.json` — a resource with no
  `egma.simulation_id`, which the ingest refuses whole with a body saying what
  to send instead.
