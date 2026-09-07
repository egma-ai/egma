# A LiveKit agent booking an appointment, in OTLP/JSON

One complete trace: a fixture LiveKit voice agent taking a booking from Egma's
own persona. 104 spans, five human turns, eleven agent turns, and **three tool
calls** — `list_providers`, `check_availability` and `book_appointment` — each
with the result the agent was handed and, where the tool takes any, the
arguments the model emitted.

It exists because two of those three calls were invisible in Egma's own record
of the run that produced it. That run — `run_01M1PRTFM4EATAYBGJ1FBE39J7` — is
what opened [ADR-0015](https://github.com/egma-ai/egma) and the agent-POV effort:
a simulation stores both POVs now, and an unmocked tool call is on the record
because the agent itself reported it. This file is the evidence that has to keep
passing.

## What is in it

| File | What it is |
| --- | --- |
| `export.json` | One `ExportTraceServiceRequest`, in the OTLP/JSON encoding |

**Encoding.** OTLP/HTTP's JSON mapping: post it with
`Content-Type: application/json`. Trace, span and parent ids are lowercase hex,
which is what that mapping specifies; the capture arrived from a Python exporter
that had written them as base64, and converting them is one of the two edits
made to it.

**What was removed, and why.** The other edit: six attributes that carried bulk
rather than evidence are dropped from every span they were on. Together they
were 139 KB of a 749 KB file, and `lk.chat_ctx` alone — the whole conversation
so far, copied again into each of sixteen LLM spans — was 116 KB of that.
Nothing in this repository asserts against any of them.

| Attribute | What it held |
| --- | --- |
| `lk.chat_ctx` | The running chat history, repeated per LLM span |
| `lk.llm_metrics` | The model call's own metrics block |
| `lk.tts_metrics` | The speech synthesis metrics block |
| `lk.provider_request_ids` | The upstream provider's request ids |
| `lk.function_tools` | The JSON schemas of every tool the agent was given |
| `lk.response.function_calls` | The model's calls, repeated on the response |

Everything else is the capture, unchanged: all 104 spans, every name, kind,
parent and timestamp, the resource attributes, every `lk.function_tool.*`, the
user transcripts and response texts, the room, job and agent identifiers, and
every latency and delay attribute. Not a timestamp and not a span was touched.

**Layout.** The file is written compact, one span per line, so that a diff reads
span by span rather than as thousands of moved brackets. It is still one valid
`ExportTraceServiceRequest` and is parsed, never pattern-matched.

**Time window.** The spans run from `2026-09-04T17:52:51.775317Z` to
`2026-09-04T17:54:13.633365Z` UTC. Timestamps are part of the capture, so
anything replaying it must ask about a window containing that interval.

**Trace.** All 104 spans are one trace, `4126ef5a2cfb0c71da235771e1be4ec4`.

**The room** is `RM_7gxYsTDmP9ZY`, on the resource as `room_id`. Note that this
is *not* one of the attributes Egma reads a provider call id from — the LiveKit
SDK version that made this capture puts no `session.id` or `lk.room_name`
anywhere. A test naming this conversation stamps `egma.provider_reference`
itself, exactly as the Egma SDK does.

## Things worth knowing before you assert against it

- **`list_providers` takes no arguments.** Its span carries
  `lk.function_tool.name` and `lk.function_tool.output` and no
  `lk.function_tool.arguments`, because there was nothing to pass. The other two
  carry all three. An absent fact stays absent, so assert results on all three
  and arguments on the two that have them.
- **Tool arguments are a kvlist**, not a string: LiveKit writes them as an OTLP
  key-value list, and Egma keeps the structure rather than flattening it into
  something that reads like a sentence.
- **No span carries `STATUS_CODE_ERROR`.** Unlike the other capture in this
  directory, this conversation went cleanly end to end. Use
  `livekit-otlp-trace` when you need a real error shape.
- **Model and TTS calls nest**: `llm_node` → `llm_request_run` → `llm_request`,
  and `tts_node` → `tts_request_run` → `tts_request`.
- **There are eleven `agent_turn` spans against five `user_turn` spans.** The
  agent opens, and it speaks again after each tool result — a turn is a turn
  whether or not the caller prompted it.

## Privacy

Nothing here is anybody's real data. The caller is Egma's persona, the agent is
a fixture agent written for this test, and the provider names, appointment and
confirmation code are all invented by that agent. There are no credentials in
the capture: the `Authorization` header lives outside a span's payload by
construction, and nothing in this file was redacted, because there was nothing
to redact. The six attributes above were dropped for size, not for privacy —
there was nothing sensitive in them either.
