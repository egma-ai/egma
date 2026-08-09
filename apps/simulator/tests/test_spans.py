"""The span emitter, held to the vocabulary and its golden fixtures.

What these prove is the emitter contract, not the conversation: the trace
identity a simulation id derives, the ids the emitter mints and replays,
the shapes a flush carries, and the one rule that makes a timing span a
measurement — its own duration *is* the number. The fixtures under
``packages/simulation-contract/fixtures/spans`` are the same document as
bytes, and this suite reads them rather than restating them, so a shape
that drifts on either side fails here.
"""

from __future__ import annotations

import json

import pytest

from egma_simulator.contract import contract_dir
from egma_simulator.spans import (
    SCOPE_NAME,
    SCOPE_VERSION,
    SERVICE_NAME,
    SIMULATION_ID_ATTRIBUTE,
    SpanEmitter,
    trace_id_for,
)

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

    def __call__(self, document: dict) -> None:
        self.documents.append(document)


class Clock:
    """A wall clock that only moves when a test says so, in nanoseconds."""

    def __init__(self, at: int = 1_785_920_400_000_000_000) -> None:
        self.at = at

    def __call__(self) -> int:
        return self.at

    def tick(self, seconds: float) -> None:
        self.at += int(seconds * 1_000_000_000)


def emitter(simulation_id: str = WORKED_EXAMPLE_ID) -> tuple[SpanEmitter, Sink, Clock]:
    sink = Sink()
    clock = Clock()
    return SpanEmitter(simulation_id, flush=sink, clock=clock), sink, clock


def spans_of(document: dict) -> list[dict]:
    return document["resourceSpans"][0]["scopeSpans"][0]["spans"]


def named(document: dict, name: str) -> list[dict]:
    return [span for span in spans_of(document) if span["name"] == name]


def attribute(span: dict, key: str) -> str | None:
    for entry in span.get("attributes", []):
        if entry["key"] == key:
            return entry["value"]["stringValue"]
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
        assert int(derived, 16) >= 0
        assert derived == trace_id_for(opaque)
    assert trace_id_for("sim-chat-001") != trace_id_for("sim-chat-002")


# -- What a flush carries -------------------------------------------------


def test_a_flush_names_its_simulation_and_rides_the_one_scope():
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("agent", "Lakeside Dental, how can I help?")
    spans.flush()

    resource = sink.documents[0]["resourceSpans"][0]
    assert resource["resource"]["attributes"] == [
        {"key": "service.name", "value": {"stringValue": SERVICE_NAME}},
        {
            "key": SIMULATION_ID_ATTRIBUTE,
            "value": {"stringValue": WORKED_EXAMPLE_ID},
        },
    ]
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
    """Barge-in's record format, proved on the shape rather than promised."""
    spans, sink, clock = emitter()
    spans.opened()

    # The agent speaks for 7.3 seconds; the persona starts answering 5.75
    # seconds in and runs 1.62 seconds past the end of it.
    clock.tick(7.3)
    spans.spoke("agent", 7.3)
    spans.turn("agent", "Thursday at three, or Friday at ten?")
    clock.tick(1.62)
    spans.turn("human", "Sorry — Friday, Friday at ten is perfect.")
    spans.spoke("human", 3.17)
    spans.flush()

    agent = named(sink.documents[0], "agent_turn")[0]
    human = named(sink.documents[0], "human_turn")[0]
    assert duration_ns(agent) == 7_300_000_000
    assert duration_ns(human) == 3_170_000_000
    # They cross: the persona began before the agent had finished.
    assert int(human["startTimeUnixNano"]) < int(agent["endTimeUnixNano"])
    assert int(human["endTimeUnixNano"]) > int(agent["endTimeUnixNano"])


def test_a_turn_spoken_before_its_words_are_known_still_gets_its_interval():
    """The agent's audio is heard, then read; the turn is one thing either way."""
    spans, sink, clock = emitter()
    spans.opened()
    clock.tick(4.0)
    spans.spoke("agent", 4.0)
    spans.turn("agent", "Of course — could I take your name?")
    spans.flush()

    turn = named(sink.documents[0], "agent_turn")[0]
    assert duration_ns(turn) == 4_000_000_000


def test_a_turn_whose_speech_is_never_measured_stays_an_instant():
    """Chat never measures speech, and a turn nobody timed is not invented."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.turn("human", "Hello.")
    spans.flush()
    spans.spoke("human", 2.0)
    spans.turn("human", "Still there?")
    spans.flush()

    first = named(sink.documents[0], "human_turn")[0]
    second = named(sink.documents[1], "human_turn")[0]
    assert duration_ns(first) == 0
    assert duration_ns(second) == 2_000_000_000


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


def test_a_conversation_that_authored_nothing_still_says_it_happened():
    """A simulation that failed before its first turn is still a simulation."""
    spans, sink, _clock = emitter()
    spans.opened()
    spans.sealed()

    assert [span["name"] for span in spans_of(sink.documents[0])] == ["simulation"]


def test_the_ids_a_conversation_mints_are_stable_across_resends():
    """The same conversation, replayed: identical ids, so a resend lands
    nothing twice at a store that dedups on them."""

    def conversation() -> list[dict]:
        spans, sink, clock = emitter()
        spans.opened()
        clock.tick(1.0)
        spans.turn("agent", "Lakeside Dental.")
        spans.flush()
        spans.sealed()
        return sink.documents

    first = conversation()
    again = conversation()
    assert json.dumps(first) == json.dumps(again)
