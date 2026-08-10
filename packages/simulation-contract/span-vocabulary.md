# The span vocabulary

**Contract version: 1**

Every span the simulator emits, named once, so that the emitter and the
platform's OTLP ingest agree on the same shapes and neither can change them
quietly.

This is a contract document, not a schema. On the wire a conversation is an
ordinary OpenTelemetry `ExportTraceServiceRequest`, posted at the same ingest
door a customer's agent posts to — that is the point of speaking OTLP at all.
What this document pins down is the part OTLP leaves open: what the spans are
called, which attributes carry the conversation, and how a batch names the
simulation it is evidence of. It sits beside `measure-catalog.md` because it is
the same kind of fact: what the simulator emits, agreed between the simulator
and the control plane, versioned so drift breaks a build instead of a customer.

The golden fixtures under `fixtures/spans/` are this document as bytes. The
`valid/` files are flushes of real conversations — the simulator emits exactly
these shapes, and the ingest's own suite posts these same files and asserts
what lands. The `invalid/` file is the one refusal the ingest makes at the
batch grain: a resource that names no simulation. Both suites read the same
files, which is what keeps the two sides from drifting apart silently.

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

The trace id is derived from the simulation id, deterministically, so the
conversation's spans and its verdicts can always find each other:

- **trace id** — the simulation id's own 128 bits: the 26 Crockford base32
  characters after `sim_` decoded to a 128-bit integer, written as 32 lowercase
  hex characters. `sim_01K3XQ7M4E8YB2FVN0H9TZQWER` is trace
  `0198fb73d08e479627eea08a75fbf1d8`, always.
- **span ids** — minted by the emitter when the span is authored, unique within
  the trace, and stable across resends: a resent flush replays the same bytes,
  ids and timestamps included, which is what lets delivery be at-least-once
  while the store's id-keyed dedup lands nothing twice.

## The instrumentation scope

Every span rides the scope named **`egma-simulator`**. The ingest recognises
the vocabulary by this scope, never by span names alone — another framework
that happens to call something `agent_turn` is not read as the simulator, and
the simulator's names can never collide with a provider's.

## The spans

A span is one timed thing inside the conversation. Timestamps are stamped when
the thing happened and replayed byte-identically on resends — never re-derived
at send time. Shapes permit overlap: two turns may cross in time, which is how
barge-in is represented when the persona becomes full-duplex, and
`voice-overlapping-turns.json` shows a pair doing it.

| Span name | One per | Duration | Attributes |
| --- | --- | --- | --- |
| `simulation` | conversation | The whole conversation. The root: it names no parent, every other span names it, and it is emitted last — when it arrives, the conversation is over and every other span is already on the wire. | none |
| `human_turn` | transcript turn spoken by the persona | The turn, ear to ear. Zero on chat, where a message is one instant. | `egma.turn.text` |
| `agent_turn` | transcript turn spoken by the agent under test | Same terms as `human_turn`. | `egma.turn.text` |
| `tool_call` | tool call observed from egma's side of the connection | One instant where the platform reports the invocation and nothing more. Where egma *answered* the call, the span brackets the exchange egma conducted — the round trip plus any delay the mock tool declared — so the delay a run was configured with is readable as the duration it actually took, and no attribute repeats the number for the two to disagree about. | `egma.tool.name`, `egma.tool.arguments`, `egma.tool.result`, `egma.tool.provenance`, `egma.tool.mock_tool`, `egma.tool.late_attached` |
| *measure name* | measurement | **The measurement itself.** A timing span is named for the measure it takes — `first_response_latency`, `turn_response_latency`, `time_to_first_word`, `agent_speech_duration`, `persona_speech_duration` — and its start and end bracket the measured interval, so the span's duration *is* the number, in nanoseconds. The catalog (`measure-catalog.md`) says what each measure means and who emits it. | none |

The speaker of a turn rides the span name — `human_turn` and `agent_turn` are
the transcript's two labels, exactly — so there is no second field free to
disagree with it.

## The attributes

| Attribute | On | Value |
| --- | --- | --- |
| `egma.turn.text` | `human_turn`, `agent_turn` | What was said, as text — spoken and transcribed on voice, sent verbatim on chat. May be empty for a turn that carried no words. |
| `egma.tool.name` | `tool_call` | The tool's name, exactly as the platform reported it. |
| `egma.tool.arguments` | `tool_call` | The arguments, JSON-encoded, exactly as observed — absent where the platform reports the invocation but not its arguments. A string deliberately: the observed bytes are the fact worth keeping. |
| `egma.tool.result` | `tool_call` | The answer the call was given, JSON-encoded, exactly as it was served. Present only where egma itself authored the answer; absent for a call egma merely watched go past. |
| `egma.tool.provenance` | `tool_call` | How the call was answered. One value: `mocked` — a mock tool answered, and egma served it. Absent means the call was observed and not answered, which is every call on a connection egma is not in the path of. |
| `egma.tool.mock_tool` | `tool_call` | The mock tool that answered, by name. Present only beside `mocked`. |
| `egma.tool.late_attached` | `tool_call` | A genuine boolean, `true` only where the call was served for a tool the session-start census never reported. Absent elsewhere: a stamp for the ordinary case would ride every span. |

**Why a result may be recorded at all.** The rule it looks like an exception to
— never record half an exchange nobody observed — is about *the agent's* return
values, which egma does not see. An answer egma itself served is not observed,
it is authored: recording it invents nothing, and a served answer with the
served half missing would be the dishonest record. So the result attribute
appears exactly where the provenance stamp does, and a call egma only watched
go past still carries neither.

**Why the tool's name and the mock tool's name are both written down.**
`egma.tool.name` is the agent's word — what the platform reported being called.
`egma.tool.mock_tool` is egma's own — the authored thing that answered. Today
they always match, because a mock tool is matched to a call by name and by
nothing else; writing both is what makes the day they stop matching visible on
the record instead of assumed away.

**What `late_attached` owns.** A closure is registered for every tool name the
run's answers cover, whether or not the census reported that tool — so a tool
attached after the census still gets a mocked answer, which is the safe
outcome. What such a call cannot promise is its arguments: with no real tool to
copy a signature from, the arguments reaching egma may be trimmed or missing
altogether. The flag carries that caveat, so a reader never mistakes thin
arguments for an agent that passed none.

## What the fixtures show

- `chat-flush-1-turns.json`, `chat-flush-2-tools.json`,
  `chat-flush-3-root.json` — one chat conversation as the three flushes the
  simulator actually sends: turns and a first-response measurement while the
  conversation runs, tool calls and a per-turn measurement as they happen, and
  the closing turn with the root last. Together they are the whole trace;
  resending any flush byte-identically lands nothing twice.
- `voice-overlapping-turns.json` — a mid-conversation voice flush where the
  persona starts speaking before the agent finishes: two turns whose intervals
  cross, with the two speech-duration measures beside them.
- `voice-mocked-tool-calls.json` — a mid-conversation flush of two calls egma
  answered: an ordinary mocked call, arguments whole and its 250 ms of declared
  delay showing as the span's duration, and a late-attached one whose arguments
  never arrived. Beside `chat-flush-2-tools.json`, whose calls carry name and
  arguments and nothing else, it is the whole range this span shape covers.
- `invalid/resource-naming-no-simulation.json` — a resource with no
  `egma.simulation_id`, which the ingest refuses whole with a body saying what
  to send instead.
