"""The ``egma.pipecat`` spans the observer writes, from a real pipeline.

A voice conversation is played into a real ``PipelineWorker`` as the frames
Pipecat's own processors push: voice activity, the user turn Pipecat
commits, transcripts, an LLM response, bot speech, and a barge-in. The
spans are read back from the export in the order they were sent.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pipecat.frames.frames")

import asyncio
import gzip
from importlib.metadata import version
from typing import Any

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from support import (
    PROJECT_KEY,
    DailyRunnerArguments,
    Recording,
    ScriptedLLM,
    Step,
    egma,
    exports,
    fixture,
    run_pipeline,
    simulation_body,
    worker_for,
)

from egma.pipecat import monitor, simulation

CALENDAR = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"


def transcript(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text=text, user_id="caller", timestamp="")


def conversation() -> list[Frame]:
    """Two exchanges; the caller cuts into the second answer."""
    return [
        VADUserStartedSpeakingFrame(),
        UserStartedSpeakingFrame(),
        transcript("Is Tuesday free?"),
        VADUserStoppedSpeakingFrame(),
        UserStoppedSpeakingFrame(),
        LLMFullResponseStartFrame(),
        LLMTextFrame("Let me "),
        LLMTextFrame("check."),
        BotStartedSpeakingFrame(),
        TTSTextFrame("Let", aggregated_by="word"),
        LLMFullResponseEndFrame(),
        BotStoppedSpeakingFrame(),
        VADUserStartedSpeakingFrame(),
        UserStartedSpeakingFrame(),
        transcript("Actually,"),
        transcript("make it Friday."),
        VADUserStoppedSpeakingFrame(),
        UserStoppedSpeakingFrame(),
        LLMFullResponseStartFrame(),
        LLMTextFrame("Friday works, "),
        BotStartedSpeakingFrame(),
        LLMTextFrame("and I will book it."),
        LLMFullResponseEndFrame(),
        InterruptionFrame(),
        BotStoppedSpeakingFrame(),
    ]


async def play(worker: Any, frames: list[Frame]) -> None:
    for frame in frames:
        await worker.queue_frame(frame)
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.2)


def children_of(spans: list[Any], parent: Any) -> list[Any]:
    return [
        s
        for s in spans
        if s.parent is not None and s.parent.span_id == parent.context.span_id
    ]


async def test_a_voice_conversation_becomes_turns_speech_and_a_root_sent_last(
    exports, monkeypatch
):
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    worker = worker_for([Recording()])

    await monitor(worker, DailyRunnerArguments(body={}, session_id="pcc-session-9"))
    await run_pipeline(worker, lambda: play(worker, conversation()))

    sink = exports.only
    spans = sink.spans
    assert spans[-1].name == "pipecat_session", (
        "the root is sent after every other span"
    )
    [root] = sink.named("pipecat_session")
    assert root.parent is None
    assert root.attributes["egma.pipecat.version"] == version("pipecat-ai")
    assert root.attributes["egma.pipecat.transport"] == "daily"
    assert all(span.context.trace_id == root.context.trace_id for span in spans)

    resource = dict(root.resource.attributes)
    assert resource["service.name"] == "pipecat"
    assert resource["session.id"] == "pcc-session-9"
    assert "egma.provider_reference" not in resource
    assert root.instrumentation_scope.name == "egma.pipecat"
    assert root.instrumentation_scope.version == version("egma")

    users = sorted(sink.named("user_turn"), key=lambda s: s.start_time)
    agents = sorted(sink.named("agent_turn"), key=lambda s: s.start_time)
    assert [u.attributes["egma.turn.text"] for u in users] == [
        "Is Tuesday free?",
        "Actually, make it Friday.",
    ]
    assert [a.attributes["egma.turn.text"] for a in agents] == [
        "Let me check.",
        "Friday works, and I will book it.",
    ]
    assert "egma.turn.interrupted" not in agents[0].attributes
    assert agents[1].attributes["egma.turn.interrupted"] is True
    assert all(turn.parent.span_id == root.context.span_id for turn in users + agents)

    # One speech span inside each turn, on each side.
    for turn, speaking in [(u, "user_speaking") for u in users] + [
        (a, "agent_speaking") for a in agents
    ]:
        [spoke] = children_of(spans, turn)
        assert spoke.name == speaking
        assert turn.start_time <= spoke.start_time <= spoke.end_time <= turn.end_time

    # The turns take their places on one timeline.
    timeline = [users[0], agents[0], users[1], agents[1]]
    for earlier, later in zip(timeline, timeline[1:], strict=False):
        assert earlier.end_time <= later.start_time
    assert root.start_time <= users[0].start_time
    assert agents[1].end_time <= root.end_time


async def test_voice_activity_that_never_became_a_turn_leaves_no_span(
    exports, monkeypatch
):
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    worker = worker_for([Recording()])

    await monitor(worker, DailyRunnerArguments(body={}))
    await run_pipeline(
        worker,
        lambda: play(
            worker, [VADUserStartedSpeakingFrame(), VADUserStoppedSpeakingFrame()]
        ),
    )

    assert [span.name for span in exports.only.spans] == ["pipecat_session"]


async def test_a_fixed_greeting_with_no_llm_response_is_an_agent_turn(
    exports, monkeypatch
):
    monkeypatch.setenv("EGMA_URL", "https://app.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    worker = worker_for([Recording()])

    await monitor(worker, DailyRunnerArguments(body={}))
    await run_pipeline(
        worker,
        lambda: play(
            worker,
            [
                BotStartedSpeakingFrame(),
                TTSTextFrame("Hello,", aggregated_by="word"),
                TTSTextFrame("welcome.", aggregated_by="word"),
                BotStoppedSpeakingFrame(),
            ],
        ),
    )

    [greeting] = exports.only.named("agent_turn")
    assert greeting.attributes["egma.turn.text"] == "Hello, welcome."
    assert [s.name for s in children_of(exports.only.spans, greeting)] == [
        "agent_speaking"
    ]


async def test_a_simulations_resource_names_it_and_its_tool_calls_sit_in_turns(
    egma, exports
):
    llm = ScriptedLLM(
        [Step(text="One moment.", calls=[("check_calendar", {"day": "Tuesday"})])]
    )
    worker = worker_for([llm])

    await simulation(worker, DailyRunnerArguments(body=simulation_body(CALENDAR)))

    async def drive() -> None:
        from pipecat.frames.frames import LLMContextFrame
        from pipecat.processors.aggregators.llm_context import LLMContext

        await worker.queue_frame(LLMContextFrame(context=LLMContext()))
        await asyncio.wait_for(llm.done.wait(), 10)
        await asyncio.sleep(0.2)

    await run_pipeline(worker, drive)

    sink = exports.only
    [root] = sink.named("pipecat_session")
    assert root.resource.attributes["egma.provider_reference"] == CALENDAR
    [turn] = sink.named("agent_turn")
    [call] = sink.named("function_call")
    assert call.parent.span_id == turn.context.span_id
    assert call.attributes["egma.tool.name"] == "check_calendar"
    assert call.attributes["egma.tool.call_id"] == "call_1"
    assert sink.spans[-1].name == "pipecat_session"


async def test_the_export_reaches_egmas_trace_door_with_the_project_key(egma):
    llm = ScriptedLLM([Step(text="Hello.")])
    worker = worker_for([llm])

    await simulation(worker, DailyRunnerArguments(body=simulation_body(CALENDAR)))

    async def drive() -> None:
        from pipecat.frames.frames import LLMContextFrame
        from pipecat.processors.aggregators.llm_context import LLMContext

        await worker.queue_frame(LLMContextFrame(context=LLMContext()))
        await asyncio.wait_for(llm.done.wait(), 10)

    await run_pipeline(worker, drive)

    assert egma.traces, "nothing reached /v1/traces"
    names: list[list[str]] = []
    for headers, body in egma.traces:
        assert headers["Authorization"] == f"Bearer {PROJECT_KEY}"
        if headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        request = ExportTraceServiceRequest.FromString(body)
        batch = []
        for resource_spans in request.resource_spans:
            resource = {
                a.key: a.value.string_value for a in resource_spans.resource.attributes
            }
            assert resource["egma.provider_reference"] == CALENDAR
            for scope_spans in resource_spans.scope_spans:
                assert scope_spans.scope.name == "egma.pipecat"
                batch.extend(span.name for span in scope_spans.spans)
        names.append(batch)
    everything = [name for batch in names for name in batch]
    assert everything[-1] == "pipecat_session"
    assert everything.count("pipecat_session") == 1
    assert "agent_turn" in everything


@pytest.mark.parametrize(
    ("runner_args", "transport"),
    [
        (DailyRunnerArguments(body={}), "daily"),
        (type("LiveKitRunnerArguments", (), {"body": {}})(), "livekit"),
        (type("SmallWebRTCRunnerArguments", (), {"body": {}})(), "webrtc"),
        ({"body": {}, "transport": "websocket"}, "websocket"),
        (object(), ""),
    ],
)
def test_the_transport_is_read_off_the_runner_arguments(runner_args, transport):
    from egma.pipecat.detect import transport_of

    assert transport_of(runner_args) == transport
