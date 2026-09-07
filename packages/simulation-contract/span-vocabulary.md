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
| `tool_call` | tool call a platform reported making | One instant. Egma did not conduct the exchange — the platform matched Egma's answers and served them itself — so there is no round trip to bracket and no duration is claimed. Only that lane emits this span: where the agent's own process runs the Egma SDK, that process reports its own calls and Egma writes no row. | `egma.tool.name`, `egma.tool.arguments`, `egma.tool.result` |
| *measure name* | measurement | **The measurement itself.** A timing span is named for the measure it takes — `first_response_latency`, `turn_response_latency`, `agent_speech_duration` — and its start and end bracket the measured interval, so the span's duration *is* the number, in nanoseconds. The catalog (`measure-catalog.md`) says what each measure means and who emits it. | none |

The speaker of a turn rides the span name — `human_turn` and `agent_turn` are
the transcript's two labels, exactly — so there is no second field free to
disagree with it.

## The attributes

| Attribute | On | Value |
| --- | --- | --- |
| `egma.turn.text` | `human_turn`, `agent_turn` | What was said, as text — spoken and transcribed on voice, sent verbatim on chat. May be empty for a turn that carried no words. |
| `egma.turn.platform_notes` | `agent_turn` | What the agent's platform said about the turn that nobody said *in* it — a node transition it announced mid-answer, a message in a role Egma has never seen. A JSON array of strings, in the order the platform said them, and absent for every turn that has none, which is nearly all of them. It rides beside `egma.turn.text` rather than inside it because the turn's text is handed back to the persona as the transcript it answers, and because one scenario's chat and voice records are only comparable while neither carries words nobody spoke. Only a connection whose platform reports such things ever emits it. |
| `egma.tool.name` | `tool_call` | The tool's name, exactly as the platform reported it. |
| `egma.tool.arguments` | `tool_call` | The arguments, JSON-encoded, exactly as the platform reported them — absent where it reported the invocation and not its arguments. A string deliberately: the reported bytes are the fact worth keeping. |
| `egma.tool.result` | `tool_call` | The answer the call was given, JSON-encoded — **Egma's own rendering of the answer it authored**, never the platform's echo of it. Present only for a tool this simulation's pinned test version covers, because only there did Egma author the answer; a call for any other name ran the customer's real implementation and its return value is not Egma's to vouch for. |

**Why there is no tool span for a call Egma served itself.** Where the agent's own
process runs the Egma SDK, that process is the tool record: every call the agent
made, with the arguments its model emitted and the result it received, one row
per call, reaching Egma by simulation ingestion. Egma's mock-tool seam still
serves the answers a test asked for and still refuses a name it has no answer
for; it writes no row of its own, so no two records of one call can disagree,
and a call Egma was never in the path of is on the record like any other.

The `tool_call` span above is the other lane, and only that one: the platform
matched Egma's answers and served them itself, nothing of Egma's runs inside the
agent, and no report of the agent's own ever arrives — so a call Egma did not
write down would land nowhere at all.

**No stamp says who answered.** Whether a call was answered by a mock tool is
read at display time, **by name**, from the pinned test version's mock tools —
the authored world itself, which cannot change under a result — so a second copy
of that fact on the span could only come to disagree with it. A call Egma refused
shows as the error the SDK raised, carried on the agent's own span for that call.
This reverses the earlier rule that Egma observed tool facts at the seam
(ADR-0015 §3), and retires the `egma.tool.provenance`, `egma.tool.mock_tool` and
`egma.tool.late_attached` attributes with it.

## What the fixtures show

- `chat-flush-1-turns.json`, `chat-flush-2-tools.json`,
  `chat-flush-3-root.json` — one chat conversation as the three flushes the
  simulator sends as its Egma-authored record: turns and a first-response
  measurement while the conversation runs, a per-turn measurement and the two
  tool calls the platform reported as they happen, and the closing turn with the
  root last. The first of those calls is for a tool this simulation covers, so
  it carries the answer Egma authored; the second is not, so it carries the name
  alone — the real implementation ran and its return is not Egma's to claim.
  Together they are the whole trace. ClickHouse suppresses a recent
  byte-identical block. Changed, regrouped, or reordered content is a different
  block and is retained even when span ids repeat; the reader never collapses
  stored rows by span id.
- `voice-overlapping-turns.json` — a mid-conversation voice flush where the
  persona starts speaking before the agent finishes: two turns whose intervals
  cross, with the agent's speech-duration measure beside them.
- `voice-flush-recording-root.json` — a closing voice flush: the zero-duration
  recording span places audio sample zero on the trace clock, followed by the
  root last.
- `invalid/resource-naming-no-simulation.json` — a resource with no
  `egma.simulation_id`, which the ingest refuses whole with a body saying what
  to send instead.
