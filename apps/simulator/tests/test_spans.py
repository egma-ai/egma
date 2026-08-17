"""The span emitter, held to the vocabulary and its golden fixtures.

What these prove is the emitter contract, not the conversation: the trace
identity a simulation id derives, SDK-owned span identity, the shapes a flush
carries, and the one rule that makes a timing span a measurement — its own
duration *is* the number. The worked examples under
``packages/simulation-contract/fixtures/spans`` pin the vocabulary and timing;
the SDK deliberately gives each new execution new span ids and resource facts.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys

import pytest
from opentelemetry import trace
from opentelemetry.proto.resource.v1.resource_pb2 import Resource
from opentelemetry.sdk.trace.sampling import ALWAYS_ON
from opentelemetry.trace import (
    Link,
    SpanContext,
    SpanKind,
    Status,
    StatusCode,
    TraceFlags,
    TraceState,
)

from egma_simulator import telemetry
from egma_simulator.contract import contract_dir
from egma_simulator.spans import (
    SCOPE_NAME,
    SCOPE_VERSION,
    SERVICE_NAME,
    SIMULATION_ID_ATTRIBUTE,
    SpanEmitter,
    trace_id_for,
)
from egma_simulator.telemetry import SimulationTraceIdGenerator

# The vocabulary's own worked example, quoted from the document.
WORKED_EXAMPLE_ID = "sim_01K3XQ7M4E8YB2FVN0H9TZQWER"
WORKED_EXAMPLE_TRACE = "0198fb73d08e479627eea08a75fbf1d8"


def fixture(name: str) -> dict:
    path = contract_dir() / "fixtures" / "spans" / "valid" / name
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class Sink:
    """Catches the documents a flush hands over, in order."""

    def __init__(self) -> None:
        self.documents: list[dict] = []

    def __call__(self, serialized: bytes) -> None:
        self.documents.append(json.loads(serialized))


class Clock:
    """A wall clock that only moves when a test says so, in nanoseconds."""

    def __init__(self, at: int = 1_785_920_400_000_000_000) -> None:
        self.at = at

    def __call__(self) -> int:
        return self.at

    def tick(self, seconds: float) -> None:
        self.at += int(seconds * 1_000_000_000)


_OPEN_EMITTERS: list[SpanEmitter] = []


@pytest.fixture(autouse=True)
def release_unsealed_emitters():
    """Most unit examples inspect a flush without ending a conversation."""
    yield
    while _OPEN_EMITTERS:
        _OPEN_EMITTERS.pop().abort()


def emitter(simulation_id: str = WORKED_EXAMPLE_ID) -> tuple[SpanEmitter, Sink, Clock]:
    sink = Sink()
    clock = Clock()
    spans = SpanEmitter(simulation_id, flush=sink, clock=clock)
    _OPEN_EMITTERS.append(spans)
    return spans, sink, clock


def spans_of(document: dict) -> list[dict]:
    return document["resourceSpans"][0]["scopeSpans"][0]["spans"]


def scopes_of(document: dict) -> list[dict]:
    return document["resourceSpans"][0]["scopeSpans"]


def named(document: dict, name: str) -> list[dict]:
    return [span for span in spans_of(document) if span["name"] == name]


def attribute(span: dict, key: str) -> str | None:
    for entry in span.get("attributes", []):
        if entry["key"] == key:
            return entry["value"]["stringValue"]
    return None


def flag(span: dict, key: str) -> bool | None:
    """One attribute the vocabulary declares a genuine boolean, read as one.

    Deliberately not through :func:`attribute`: a flag that arrived as a
    string would come back from that one looking perfectly fine, and this
    is the reader that would notice.
    """
    for entry in span.get("attributes", []):
        if entry["key"] == key:
            return entry["value"]["boolValue"]
    return None


def duration_ns(span: dict) -> int:
    return int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])


# -- Trace identity -------------------------------------------------------


def test_the_trace_id_is_the_simulation_ids_own_bits():
    """The vocabulary's worked example, and the fixtures' second id too."""
    assert trace_id_for(WORKED_EXAMPLE_ID) == WORKED_EXAMPLE_TRACE
    assert (
        trace_id_for("sim_01K3XSW9GJ2Q4RD8VXH0MEKAFP")
        == "0198fb9e261215c986a37d8828e9a9f6"
    )


def test_every_span_fixture_derives_its_trace_id_from_its_simulation():
    """The golden files and this emitter agree on the derivation, both ways."""
    for name in ("chat-flush-1-turns.json", "voice-overlapping-turns.json"):
        document = fixture(name)
        resource = document["resourceSpans"][0]
        simulation_id = next(
            entry["value"]["stringValue"]
            for entry in resource["resource"]["attributes"]
            if entry["key"] == SIMULATION_ID_ATTRIBUTE
        )
        expected = trace_id_for(simulation_id)
        for span in resource["scopeSpans"][0]["spans"]:
            assert span["traceId"] == expected


def test_an_id_that_is_not_egmas_own_shape_still_gets_one_trace():
    """The contract calls a simulation id opaque, so a derivation must hold
    for one this deployment did not mint — and hold to the same id."""
    for opaque in ("sim-chat-001", "", "sim_not-crockford", "sim_" + "Z" * 26):
        derived = trace_id_for(opaque)
        assert len(derived) == 32
        assert int(derived, 16) > 0
        assert derived == trace_id_for(opaque)
    assert trace_id_for("sim-chat-001") != trace_id_for("sim-chat-002")


def test_the_all_zero_simulation_id_names_no_valid_otel_trace():
    with pytest.raises(ValueError, match="all-zero OpenTelemetry trace id"):
        trace_id_for("sim_00000000000000000000000000")


# -- What a flush carries -------------------------------------------------


def test_a_flush_names_its_simulation_and_rides_the_one_scope():
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("agent", "Lakeside Dental, how can I help?")
    spans.flush()

    resource = sink.documents[0]["resourceSpans"][0]
    resource_attributes = {
        entry["key"]: entry["value"] for entry in resource["resource"]["attributes"]
    }
    assert resource_attributes["service.name"] == {"stringValue": SERVICE_NAME}
    assert resource_attributes[SIMULATION_ID_ATTRIBUTE] == {
        "stringValue": WORKED_EXAMPLE_ID
    }
    assert resource["scopeSpans"][0]["scope"] == {
        "name": SCOPE_NAME,
        "version": SCOPE_VERSION,
    }


def test_a_turn_carries_its_speaker_in_its_name_and_its_words_in_one_attribute():
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("human", "Could we do Thursday instead?")
    spans.turn("agent", "You're all set for Thursday at three.")
    spans.flush()

    turns = spans_of(sink.documents[0])
    assert [span["name"] for span in turns] == ["human_turn", "agent_turn"]
    assert attribute(turns[0], "egma.turn.text") == "Could we do Thursday instead?"
    assert attribute(turns[1], "egma.turn.text") == (
        "You're all set for Thursday at three."
    )


def test_a_chat_turn_is_one_instant():
    """A message has no duration, and the fixtures say so to the byte."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("human", "Hello.")
    spans.flush()

    turn = spans_of(sink.documents[0])[0]
    assert turn["startTimeUnixNano"] == turn["endTimeUnixNano"]


def test_a_tool_call_is_one_instant_carrying_what_was_observed():
    spans, sink, _clock = emitter()
    spans.opened()
    spans.tool_call("reschedule_appointment", '{"appointment_id":"apt-88213"}')
    spans.tool_call("send_confirmation_sms", None)
    spans.flush()

    calls = named(sink.documents[0], "tool_call")
    assert len(calls) == 2
    assert calls[0]["startTimeUnixNano"] == calls[0]["endTimeUnixNano"]
    assert attribute(calls[0], "egma.tool.name") == "reschedule_appointment"
    assert attribute(calls[0], "egma.tool.arguments") == (
        '{"appointment_id":"apt-88213"}'
    )
    # Absent rather than null: the platform reported the invocation and not
    # its arguments, and an absent fact is the honest record of that.
    assert attribute(calls[1], "egma.tool.name") == "send_confirmation_sms"
    assert attribute(calls[1], "egma.tool.arguments") is None


def test_a_call_egma_answered_carries_the_whole_exchange():
    """The golden file's own three calls, authored by the emitter.

    ``voice-mocked-tool-calls.json`` is the vocabulary as bytes for every
    call that reaches egma: an ordinary served one with its arguments
    whole and its declared delay showing as the span's own duration, a
    late-attached one whose arguments never arrived, and one egma refused.
    What the emitter produces has to be those attributes exactly, or the
    two sides of the contract have drifted.
    """
    golden = spans_of(fixture("voice-mocked-tool-calls.json"))
    spans, sink, _clock = emitter()
    spans.opened()
    for served in golden:
        spans.tool_exchange(
            attribute(served, "egma.tool.name"),
            arguments=attribute(served, "egma.tool.arguments"),
            answer=attribute(served, "egma.tool.result"),
            mock_tool=attribute(served, "egma.tool.mock_tool"),
            late_attached=flag(served, "egma.tool.late_attached") is True,
            refused=attribute(served, "egma.tool.provenance") == "refused",
            began_unix_nano=int(served["startTimeUnixNano"]),
            ended_unix_nano=int(served["endTimeUnixNano"]),
        )
    spans.flush()

    authored = named(sink.documents[0], "tool_call")
    for mine, theirs in zip(authored, golden, strict=True):
        assert mine["attributes"] == theirs["attributes"]
        assert duration_ns(mine) == duration_ns(theirs)

    # And the declared delay really is the duration, with no attribute
    # anywhere repeating the number for the two to disagree about.
    assert duration_ns(authored[0]) == 250 * 1_000_000
    assert flag(authored[1], "egma.tool.late_attached") is True


def test_the_late_attached_flag_is_a_genuine_boolean_and_only_ever_true():
    """A flag written as the string ``"true"`` is a flag every reader has
    to know to parse, and one of them eventually will not. It is absent
    for the ordinary case, because a stamp that rode every span would tell
    a reader nothing."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.tool_exchange(
        "send_confirmation_sms",
        answer='{"delivered":true}',
        mock_tool="send_confirmation_sms",
        late_attached=True,
        began_unix_nano=1,
        ended_unix_nano=2,
    )
    spans.tool_exchange(
        "check_calendar",
        answer='{"slots":[]}',
        mock_tool="check_calendar",
        began_unix_nano=3,
        ended_unix_nano=4,
    )
    spans.flush()

    late, ordinary = named(sink.documents[0], "tool_call")
    assert flag(late, "egma.tool.late_attached") is True
    assert flag(ordinary, "egma.tool.late_attached") is None


def test_a_result_is_never_recorded_without_the_stamp_that_placed_it():
    """The contract's one inviolable rule about a tool call, held here
    rather than discovered by a reader of the record: an answer with
    nothing to say where it came from would read as a result egma observed
    rather than one it authored."""
    spans, _sink, _clock = emitter()
    spans.opened()
    for half in ({"answer": '{"slots":[]}'}, {"mock_tool": "check_calendar"}):
        with pytest.raises(ValueError) as refused:
            spans.tool_exchange(
                "check_calendar", began_unix_nano=1, ended_unix_nano=2, **half
            )
        assert "one fact" in str(refused.value)


def test_a_refused_call_is_stamped_and_carries_nothing_it_was_never_given():
    """The stamp that keeps a refusal from reading as a pass-through.

    A call egma would not answer never reached a backend. A call with no
    stamp at all *did* — the real tool ran with egma nowhere near it. The
    two are opposite facts about the agent's own systems, so the record
    gives them different shapes.
    """
    spans, sink, _clock = emitter()
    spans.opened()
    spans.tool_exchange(
        "charge_card",
        arguments='{"amount_cents":4200}',
        refused=True,
        began_unix_nano=1,
        ended_unix_nano=2,
    )
    spans.tool_call("lookup_weather", '{"city":"Berlin"}')
    spans.flush()

    refused_call, observed = named(sink.documents[0], "tool_call")
    assert attribute(refused_call, "egma.tool.provenance") == "refused"
    # Nothing answered it, so there is nothing to record as an answer and no
    # mock tool to name.
    assert attribute(refused_call, "egma.tool.result") is None
    assert attribute(refused_call, "egma.tool.mock_tool") is None
    # And the call egma only watched go past still carries no stamp, which is
    # what makes the two readable apart.
    assert attribute(observed, "egma.tool.provenance") is None


def test_the_two_stamps_of_one_moment_are_never_written_together():
    """A refusal and an answer are opposite halves of the same instant,
    and only one of them happened. And late-attached is a caveat about a
    call egma *served*: on a call nothing served it would be a stamp with
    no fact under it."""
    spans, _sink, _clock = emitter()
    spans.opened()

    with pytest.raises(ValueError) as both:
        spans.tool_exchange(
            "check_calendar",
            answer='{"slots":[]}',
            mock_tool="check_calendar",
            refused=True,
            began_unix_nano=1,
            ended_unix_nano=2,
        )
    assert "only one of them happened" in str(both.value)

    with pytest.raises(ValueError) as unserved:
        spans.tool_exchange(
            "charge_card",
            late_attached=True,
            refused=True,
            began_unix_nano=1,
            ended_unix_nano=2,
        )
    assert "nothing to qualify" in str(unserved.value)


@pytest.mark.parametrize(
    "measure",
    [
        "first_response_latency",
        "turn_response_latency",
        "time_to_first_word",
        "agent_speech_duration",
        "persona_speech_duration",
    ],
)
def test_a_timing_spans_own_duration_is_the_measurement(measure):
    """All five of the catalog's timing measures, each one its own span."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.measure(measure, 1214.0)
    spans.flush()

    timing = named(sink.documents[0], measure)[0]
    assert duration_ns(timing) == 1_214_000_000
    assert "attributes" not in timing


def test_a_measure_brackets_the_interval_it_measured():
    """It ends when the measurement was taken and opens one measurement back."""
    spans, sink, clock = emitter()
    spans.opened()
    clock.tick(5.0)
    spans.measure("turn_response_latency", 900.0)
    spans.flush()

    timing = spans_of(sink.documents[0])[0]
    assert int(timing["endTimeUnixNano"]) == clock.at
    assert int(timing["startTimeUnixNano"]) == clock.at - 900_000_000


# -- Overlap, which is what voice needs -----------------------------------


def test_two_turns_may_cross_in_time():
    """Barge-in's record format, proved on the shape rather than promised.

    Both ends of a spoken turn arrive together, off the conversation's own
    audio clock, so two of them crossing is a fact about the audio rather
    than about when either was noticed.
    """
    spans, sink, clock = emitter()
    spans.opened()

    # The agent speaks for 7.3 seconds; the persona starts answering 5.75
    # seconds in and runs 1.62 seconds past the end of it.
    opened = clock.at
    spans.spoken_turn(
        "agent",
        "Thursday at three, or Friday at ten?",
        began_unix_nano=opened,
        ended_unix_nano=opened + 7_300_000_000,
    )
    spans.spoken_turn(
        "human",
        "Sorry — Friday, Friday at ten is perfect.",
        began_unix_nano=opened + 5_750_000_000,
        ended_unix_nano=opened + 5_750_000_000 + 3_170_000_000,
    )
    spans.flush()

    agent = named(sink.documents[0], "agent_turn")[0]
    human = named(sink.documents[0], "human_turn")[0]
    assert duration_ns(agent) == 7_300_000_000
    assert duration_ns(human) == 3_170_000_000
    # They cross: the persona began before the agent had finished.
    assert int(human["startTimeUnixNano"]) < int(agent["endTimeUnixNano"])
    assert int(human["endTimeUnixNano"]) > int(agent["endTimeUnixNano"])


def test_a_turn_nobody_spoke_is_an_instant():
    """Chat messages have no duration, and one is not invented for them.

    The two ways a turn is authored are one per conductor: the walk knows
    only when a message arrived, and the voice conductor knows both ends
    of the audio. Nothing joins them after the fact any more.
    """
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("human", "Hello.")
    spans.flush()

    only = named(sink.documents[0], "human_turn")[0]
    assert duration_ns(only) == 0


# -- The trace's own shape ------------------------------------------------


def test_every_span_names_the_root_as_its_parent_and_the_root_names_none():
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("human", "Hello.")
    spans.flush()
    spans.measure("turn_response_latency", 10.0)
    spans.sealed()

    everything = [span for document in sink.documents for span in spans_of(document)]
    root = next(span for span in everything if span["name"] == "simulation")
    assert "parentSpanId" not in root
    for span in everything:
        if span is root:
            continue
        assert span["parentSpanId"] == root["spanId"]
        assert span["traceId"] == root["traceId"] == WORKED_EXAMPLE_TRACE


def test_the_root_goes_last_and_covers_the_whole_conversation():
    spans, sink, clock = emitter()
    began = clock.at
    spans.opened()
    clock.tick(50.0)
    spans.turn("agent", "Anything else?")
    spans.sealed()

    last = sink.documents[-1]
    assert spans_of(last)[-1]["name"] == "simulation"
    root = named(last, "simulation")[0]
    assert int(root["startTimeUnixNano"]) == began
    assert int(root["endTimeUnixNano"]) == clock.at
    assert duration_ns(root) == 50_000_000_000


def test_no_span_is_ever_sent_twice_and_every_flush_is_disjoint():
    spans, sink, _clock = emitter()
    spans.opened()
    for turn in range(6):
        spans.turn("human", f"Turn {turn}.")
        spans.measure("turn_response_latency", 12.0)
        spans.turn("agent", f"Answer {turn}.")
        spans.flush()
    spans.sealed()

    per_flush = [
        {span["spanId"] for span in spans_of(document)} for document in sink.documents
    ]
    everything = [span for document in sink.documents for span in spans_of(document)]
    assert len(everything) == len({span["spanId"] for span in everything})
    for position, ids in enumerate(per_flush):
        for other in per_flush[position + 1 :]:
            assert ids.isdisjoint(other)


def test_an_empty_flush_sends_nothing():
    """A document with no spans is a request nobody needed to make."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.flush()
    spans.flush()
    assert sink.documents == []


def test_a_failed_final_wal_handoff_releases_the_simulation_route():
    """A WAL write failure blocks terminal delivery but must not leave the
    process-wide provider claiming that the simulation is still active."""

    def unavailable_wal(_serialized: bytes) -> None:
        raise OSError("the WAL is unavailable")

    simulation_id = "sim-final-flush-failure"
    spans = SpanEmitter(simulation_id, flush=unavailable_wal)
    replacement = SpanEmitter(simulation_id, flush=Sink())
    spans.opened()
    try:
        with pytest.raises(RuntimeError, match="could not write every ended span"):
            spans.sealed()
        replacement.opened()
    finally:
        spans.abort()
        replacement.abort()


def test_a_conversation_that_authored_nothing_still_says_it_happened():
    """A simulation that failed before its first turn is still a simulation."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.sealed()

    assert [span["name"] for span in spans_of(sink.documents[0])] == ["simulation"]


def test_the_sdk_mints_span_ids_instead_of_replaying_derived_ids():
    """Trace identity stays tied to the simulation, while span identity is
    owned by the OpenTelemetry SDK. Durable retry replays serialized bytes;
    conducting the same words again is new evidence with new span ids."""

    def conversation() -> list[dict]:
        spans, sink, clock = emitter()
        spans.opened()
        clock.tick(1.0)
        spans.turn("agent", "Lakeside Dental.")
        spans.flush()
        spans.sealed()
        return sink.documents

    first = [span for document in conversation() for span in spans_of(document)]
    again = [span for document in conversation() for span in spans_of(document)]

    assert {span["traceId"] for span in first + again} == {WORKED_EXAMPLE_TRACE}
    assert {span["spanId"] for span in first}.isdisjoint(
        {span["spanId"] for span in again}
    )


def test_the_identity_adapter_supplies_only_the_simulation_root_trace_id():
    spans, _sink, _clock = emitter("sim-root-identity-only")
    spans.opened()

    unrelated_parentless_trace = SimulationTraceIdGenerator().generate_trace_id()

    assert unrelated_parentless_trace != int(spans.trace_id, 16)


def test_evidence_sampling_cannot_be_disabled_by_global_otel_settings(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("OTEL_TRACES_SAMPLER", "always_off")
    assert telemetry._PROVIDER.sampler is ALWAYS_ON

    monkeypatch.setenv("OTEL_SDK_DISABLED", " true ")
    with pytest.raises(RuntimeError, match="OTEL_SDK_DISABLED"):
        telemetry._ensure_sdk_enabled()


def test_global_otel_limits_cannot_truncate_or_drop_evidence():
    """A fresh provider ignores host-wide limits that would lose raw fields."""
    proof = r"""
import json

from opentelemetry import trace
from opentelemetry.trace import Link, SpanContext, TraceFlags

from egma_simulator.spans import SpanEmitter

documents = []
evidence = SpanEmitter("sim-limit-proof", flush=documents.append)
evidence.opened()
links = [
    Link(
        SpanContext(
            trace_id=index + 1,
            span_id=index + 1,
            is_remote=False,
            trace_flags=TraceFlags.SAMPLED,
        ),
        attributes={"link.first": "unabridged", "link.second": "preserved"},
    )
    for index in range(2)
]
span = trace.get_tracer("pipecat").start_span(
    "llm",
    attributes={"span.first": "unabridged", "span.second": "preserved"},
    links=links,
)
span.add_event(
    "first",
    {"event.first": "unabridged", "event.second": "preserved"},
)
span.add_event(
    "second",
    {"event.first": "unabridged", "event.second": "preserved"},
)
span.end()
evidence.flush()
evidence.abort()
document = json.loads(documents[0])
exported = next(
    span
    for resource in document["resourceSpans"]
    for scoped in resource["scopeSpans"]
    for span in scoped["spans"]
    if span["name"] == "llm"
)
print(json.dumps(exported))
"""
    environment = os.environ.copy()
    for name in (
        "OTEL_ATTRIBUTE_COUNT_LIMIT",
        "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
        "OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT",
        "OTEL_LINK_ATTRIBUTE_COUNT_LIMIT",
        "OTEL_SPAN_EVENT_COUNT_LIMIT",
        "OTEL_SPAN_LINK_COUNT_LIMIT",
        "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
        "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
    ):
        environment[name] = "1"

    finished = subprocess.run(
        [sys.executable, "-c", proof],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    exported = json.loads(finished.stdout)

    assert {
        entry["key"]: entry["value"]["stringValue"] for entry in exported["attributes"]
    } == {"span.first": "unabridged", "span.second": "preserved"}
    assert [event["name"] for event in exported["events"]] == ["first", "second"]
    assert all(len(event["attributes"]) == 2 for event in exported["events"])
    assert len(exported["links"]) == 2
    assert all(len(link["attributes"]) == 2 for link in exported["links"])


def test_the_simulation_resource_key_cannot_be_overridden_by_global_attributes():
    resource = Resource()
    wrong = resource.attributes.add()
    wrong.key = SIMULATION_ID_ATTRIBUTE
    wrong.value.string_value = "sim-wrong"
    kept = resource.attributes.add()
    kept.key = "deployment.environment"
    kept.value.string_value = "test"
    duplicate = resource.attributes.add()
    duplicate.key = SIMULATION_ID_ATTRIBUTE
    duplicate.value.string_value = "sim-also-wrong"

    telemetry._stamp_simulation_id(resource, "sim-right")

    assert [(entry.key, entry.value.string_value) for entry in resource.attributes] == [
        (SIMULATION_ID_ATTRIBUTE, "sim-right"),
        ("deployment.environment", "test"),
    ]


async def test_concurrent_simulations_keep_their_contexts_and_exports_isolated():
    """One provider serves both tasks without mixing trace or attribution."""
    ready = 0
    both_ready = asyncio.Event()

    async def conversation(simulation_id: str, words: str) -> tuple[str, Sink]:
        nonlocal ready
        spans, sink, _clock = emitter(simulation_id)
        spans.opened()
        ready += 1
        if ready == 2:
            both_ready.set()
        await both_ready.wait()
        # This tracer is how Pipecat service decorators obtain their spans.
        with trace.get_tracer("pipecat").start_as_current_span("stt"):
            await asyncio.sleep(0)
        spans.turn("human", words)
        spans.flush()
        spans.sealed()
        return simulation_id, sink

    results = await asyncio.gather(
        conversation("sim-concurrent-a", "alpha"),
        conversation("sim-concurrent-b", "bravo"),
    )

    for simulation_id, sink in results:
        expected_trace = trace_id_for(simulation_id)
        resources = [document["resourceSpans"][0] for document in sink.documents]
        assert {
            next(
                attribute["value"]["stringValue"]
                for attribute in resource["resource"]["attributes"]
                if attribute["key"] == SIMULATION_ID_ATTRIBUTE
            )
            for resource in resources
        } == {simulation_id}
        exported = [
            span
            for resource in resources
            for scoped in resource["scopeSpans"]
            for span in scoped["spans"]
        ]
        assert {span["traceId"] for span in exported} == {expected_trace}
        assert {span["name"] for span in exported} == {
            "stt",
            "human_turn",
            "simulation",
        }


def test_pipecat_scope_status_event_link_and_attributes_reach_raw_otlp_unchanged():
    spans, sink, _clock = emitter("sim-framework-fields")
    spans.opened()
    linked = SpanContext(
        trace_id=0x1234567890ABCDEF1234567890ABCDEF,
        span_id=0x1234567890ABCDEF,
        is_remote=True,
        trace_flags=TraceFlags.SAMPLED,
        trace_state=TraceState((("vendor", "kept"),)),
    )
    framework = trace.get_tracer("pipecat").start_span(
        "tts",
        kind=SpanKind.CLIENT,
        attributes={"pipecat.native": "kept", "pipecat.rate": 16_000},
        links=[Link(linked, attributes={"pipecat.link": "kept"})],
    )
    framework.add_event(
        "audio-ready", {"pipecat.event": "kept"}, timestamp=1_785_920_401_000_000_000
    )
    framework.set_status(Status(StatusCode.ERROR, "native status"))
    framework.end(end_time=1_785_920_402_000_000_000)
    spans.flush()

    pipecat_scope = next(
        scoped
        for document in sink.documents
        for scoped in scopes_of(document)
        if scoped["scope"]["name"] == "pipecat"
    )
    assert pipecat_scope["scope"] == {"name": "pipecat"}
    (exported,) = pipecat_scope["spans"]
    assert exported["name"] == "tts"
    assert exported["kind"] == 3
    # The low byte says sampled. The simulation-derived trace id is not random;
    # the high bit says the local/remote state is known (and the missing second
    # bit says this context is local).
    assert exported["flags"] == 257
    assert attribute(exported, "pipecat.native") == "kept"
    assert (
        next(
            item["value"]["intValue"]
            for item in exported["attributes"]
            if item["key"] == "pipecat.rate"
        )
        == "16000"
    )
    assert exported["status"] == {
        "message": "native status",
        "code": 2,
    }
    assert exported["events"] == [
        {
            "timeUnixNano": "1785920401000000000",
            "name": "audio-ready",
            "attributes": [{"key": "pipecat.event", "value": {"stringValue": "kept"}}],
        }
    ]
    assert exported["links"] == [
        {
            "traceId": "1234567890abcdef1234567890abcdef",
            "spanId": "1234567890abcdef",
            "traceState": "vendor=kept",
            "attributes": [{"key": "pipecat.link", "value": {"stringValue": "kept"}}],
            # The low byte is TraceFlags.SAMPLED; the two high bits are the
            # OTLP context-has-is-remote and context-is-remote masks.
            "flags": 769,
        }
    ]
