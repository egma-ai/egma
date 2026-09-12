from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from pipecat.frames.frames import (
    EndFrame,
    ErrorFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import WorkerRunner
from pipecat.pipeline.worker import PipelineWorker
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from egma_simulator import conductor as conductor_module
from egma_simulator.media import PlayoutStamp
from egma_simulator.provider_keys import ProviderKeyUnavailable
from egma_simulator.speech import PersonaVoice, SpeechFault, SpeechProviders, build_legs


class _HeldResponse:
    status_code = 200

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.first = asyncio.Event()
        self.first_sent = asyncio.Event()
        self.middle = asyncio.Event()
        self.ended = asyncio.Event()

    async def __aenter__(self):
        self.entered.set()
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def text(self) -> str:
        return ""

    async def iter_bytes(self, _chunk_size: int):
        await self.first.wait()
        yield b"\x01\x00" * 2_400
        self.first_sent.set()
        await self.middle.wait()
        yield b"\x02\x00" * 2_400
        self.ended.set()


class _CreateResponse:
    def __init__(self, *responses: _HeldResponse) -> None:
        self._responses = iter(responses)
        self.calls: list[dict[str, object]] = []

    def __call__(self, **kwargs: object) -> _HeldResponse:
        self.calls.append(kwargs)
        return next(self._responses)


class _EmptyResponse(_HeldResponse):
    async def iter_bytes(self, _chunk_size: int):
        self.ended.set()
        if False:
            yield b""


class _FailingResponse(_HeldResponse):
    async def iter_bytes(self, _chunk_size: int):
        raise RuntimeError("fixture stream failed")
        if False:
            yield b""


class _AuthFailureResponse(_HeldResponse):
    async def __aenter__(self):
        response = httpx.Response(
            401, request=httpx.Request("POST", "https://provider.test/audio")
        )
        raise httpx.HTTPStatusError(
            "unauthorized", request=response.request, response=response
        )


class _AcceptedOutput(BaseOutputTransport):
    def __init__(self) -> None:
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=24_000,
                audio_out_channels=1,
            )
        )
        self.accepted = 0

    async def start(self, frame) -> None:
        await super().start(frame)
        asyncio.create_task(self.set_transport_ready(frame))

    async def write_audio_frame(self, _frame) -> bool:
        self.accepted += 1
        return True


class _Conductor:
    def __init__(self) -> None:
        self.positions = []
        self.positions_at_stop = []
        self.stopped = asyncio.Event()

    @property
    def deliberate_response_owned(self) -> bool:
        return False

    def persona_audio(self, _frame, *, recorded_until) -> None:
        self.positions.append(recorded_until)

    async def persona_stopped(self) -> None:
        self.positions_at_stop.append(tuple(self.positions))
        self.stopped.set()

    def persona_interrupted(self, **_kwargs: object) -> None:
        pass

    def media_advanced(self) -> None:
        pass


class _PendingVoiceTurn(_Conductor):
    def __init__(self) -> None:
        super().__init__()
        self._pending_persona_text = None
        self._pending_persona_concludes = False
        self._pending_silence_follow_up = 0
        self._persona_began = None
        self._persona_ended = None
        self._cancel_after_accepted_audio = None
        self._owes_a_turn = True
        self._record = SimpleNamespace(
            persona_last_stopped_at=None,
            quiet_since=0,
            persona_response_pending=False,
        )
        self.turns: list[str] = []
        self.stop_count = 0
        self.stop_errors: list[BaseException] = []
        self.interrupted = asyncio.Event()
        self.interruption_finished = asyncio.Event()
        conductor_module.VoiceConductor.persona_will_speak(self, "fixture reply")

    persona_audio = conductor_module.VoiceConductor.persona_audio

    def persona_interrupted(self, *, heard_through) -> None:
        conductor_module.VoiceConductor.persona_interrupted(
            self, heard_through=heard_through
        )
        self.interruption_finished.set()

    def persona_will_not_finish(self) -> None:
        conductor_module.VoiceConductor.persona_will_not_finish(self)
        self.interrupted.set()

    async def persona_stopped(self) -> None:
        try:
            await conductor_module.VoiceConductor.persona_stopped(self)
        except BaseException as fault:
            self.stop_errors.append(fault)
            raise
        finally:
            self.stop_count += 1
            self.stopped.set()

    async def _took_a_turn(self, _speaker, text, *_positions, **_kwargs) -> None:
        self.turns.append(text)


class _Media:
    def input_recorded(self, _frame) -> None:
        pass


def _openai_tts(*responses: _HeldResponse, customer_funded: bool = False):
    legs = build_legs(
        SpeechProviders(
            stt="scripted",
            tts="openai",
            tts_key="fixture-key",
            tts_model="gpt-4o-mini-tts",
            tts_customer_funded=customer_funded,
        ),
        voice=PersonaVoice(voice_id="alloy", provider="openai", speed=1.0),
    )
    tts = legs.tts
    create = _CreateResponse(*responses)
    tts._client = SimpleNamespace(
        audio=SimpleNamespace(
            speech=SimpleNamespace(
                with_streaming_response=SimpleNamespace(
                    create=create
                )
            )
        )
    )
    return tts, create


@pytest.mark.asyncio
async def test_openai_http_tts_completes_on_eof_not_an_idle_gap(monkeypatch) -> None:
    import pipecat.utils.string

    monkeypatch.setattr(
        pipecat.utils.string,
        "_sent_tokenizer",
        lambda: (
            lambda text: [
                f"{part.strip()}." for part in text.split(".") if part.strip()
            ]
        ),
    )
    first_response = _HeldResponse()
    second_response = _HeldResponse()
    tts, create = _openai_tts(first_response, second_response)
    output = _AcceptedOutput()
    recorder = conductor_module._EvidenceRecorder(
        num_channels=2, auto_start_recording=True
    )
    conductor = _Conductor()
    timeline = conductor_module._Timeline(conductor, _Media(), recorder)
    worker = PipelineWorker(
        Pipeline([tts, output, PlayoutStamp(), recorder, timeline]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())

    spoken = "First sentence. Second sentence."
    try:
        await worker.queue_frames(
            [
                LLMFullResponseStartFrame(),
                TextFrame(spoken),
                LLMFullResponseEndFrame(),
            ]
        )
        await asyncio.wait_for(first_response.entered.wait(), 5)
        assert len(tts._audio_contexts) == 1
        context_id = next(iter(tts._audio_contexts))
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(conductor.stopped.wait(), 3.2)

        first_response.first.set()
        await asyncio.wait_for(first_response.first_sent.wait(), 5)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(conductor.stopped.wait(), 3.2)

        first_response.middle.set()
        await asyncio.wait_for(first_response.ended.wait(), 5)
        await asyncio.wait_for(second_response.entered.wait(), 5)
        assert list(tts._audio_contexts) == [context_id]
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(conductor.stopped.wait(), 3.2)

        second_response.first.set()
        await asyncio.wait_for(second_response.first_sent.wait(), 5)
        second_response.middle.set()
        await asyncio.wait_for(second_response.ended.wait(), 5)
        await asyncio.wait_for(conductor.stopped.wait(), 1)
        assert len(conductor.positions_at_stop) == 1
        assert conductor.positions_at_stop[0]
        assert max(conductor.positions_at_stop[0]) > 0
        assert output.accepted > 0
        assert [call["input"] for call in create.calls] == [
            "First sentence.",
            "Second sentence.",
        ]

        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 5)
    finally:
        if not running.done():
            await asyncio.wait_for(worker.cancel(), 5)
            await asyncio.wait_for(running, 5)


@pytest.mark.asyncio
async def test_openai_http_tts_cancellation_reaps_the_held_context() -> None:
    response = _HeldResponse()
    tts, _create = _openai_tts(response)
    output = _AcceptedOutput()
    worker = PipelineWorker(
        Pipeline([tts, output]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    await worker.queue_frames(
        [
            LLMFullResponseStartFrame(),
            TextFrame("Held response."),
            LLMFullResponseEndFrame(),
        ]
    )
    await asyncio.wait_for(response.entered.wait(), 5)
    assert tts._audio_contexts

    await asyncio.wait_for(worker.cancel(), 5)
    await asyncio.wait_for(running, 5)

    assert not tts._audio_contexts


@pytest.mark.asyncio
async def test_openai_interruption_before_audio_has_no_late_completion() -> None:
    response = _HeldResponse()
    next_response = _HeldResponse()
    tts, _create = _openai_tts(response, next_response)
    output = _AcceptedOutput()
    recorder = conductor_module._EvidenceRecorder(
        num_channels=2, auto_start_recording=True
    )
    conductor = _PendingVoiceTurn()
    timeline = conductor_module._Timeline(conductor, _Media(), recorder)
    replies = conductor_module._PersonaReplyGate(
        service=SimpleNamespace(), conductor=conductor
    )
    worker = PipelineWorker(
        Pipeline([replies, tts, output, PlayoutStamp(), recorder, timeline]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    failed = asyncio.Event()

    @worker.event_handler("on_pipeline_error")
    async def on_error(_worker, frame: ErrorFrame) -> None:
        if frame.fatal:
            failed.set()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await worker.queue_frames(
            [
                LLMFullResponseStartFrame(),
                TextFrame("fixture reply"),
                LLMFullResponseEndFrame(),
            ]
        )
        await asyncio.wait_for(response.entered.wait(), 1)
        await worker.queue_frame(InterruptionFrame())
        await asyncio.wait_for(conductor.interrupted.wait(), 1)
        assert conductor._pending_persona_text is None
        await asyncio.wait_for(conductor.stopped.wait(), 1)
        await asyncio.wait_for(conductor.interruption_finished.wait(), 1)
        assert conductor.stop_errors == []
        assert not tts._audio_contexts
        assert conductor.turns == []

        conductor.stopped.clear()
        conductor_module.VoiceConductor.persona_will_speak(conductor, "Next reply")
        await worker.queue_frames(
            [
                LLMFullResponseStartFrame(),
                TextFrame("Next reply"),
                LLMFullResponseEndFrame(),
            ]
        )
        await asyncio.wait_for(next_response.entered.wait(), 1)
        next_response.first.set()
        await asyncio.wait_for(next_response.first_sent.wait(), 1)
        next_response.middle.set()
        await asyncio.wait_for(next_response.ended.wait(), 1)
        await asyncio.wait_for(conductor.stopped.wait(), 1)
        assert conductor.stop_errors == []
        assert not failed.is_set()
        assert conductor.stop_count == 2
        assert conductor.turns == ["Next reply"]
    finally:
        if not running.done():
            await worker.cancel()
        await asyncio.wait_for(running, 1)


@pytest.mark.asyncio
async def test_openai_customer_auth_error_is_yielded_once() -> None:
    tts, _create = _openai_tts(_AuthFailureResponse(), customer_funded=True)
    context_id = tts.create_context_id()
    await tts.create_audio_context(context_id)

    frames = [frame async for frame in tts.run_tts("Denied.", context_id)]

    assert len(frames) == 1
    assert isinstance(frames[0], ErrorFrame)
    assert isinstance(frames[0].exception, httpx.HTTPStatusError)
    assert str(ProviderKeyUnavailable("openai")) == frames[0].error


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "error_type"),
    [(_EmptyResponse, SpeechFault), (_FailingResponse, RuntimeError)],
)
async def test_openai_http_tts_failure_reaps_context_through_pipeline(
    response, error_type
) -> None:
    tts, _create = _openai_tts(response())
    worker = PipelineWorker(
        Pipeline([tts, _AcceptedOutput()]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    failed = asyncio.Event()
    errors: list[ErrorFrame] = []

    @worker.event_handler("on_pipeline_error")
    async def on_error(_worker, frame: ErrorFrame) -> None:
        errors.append(frame)
        failed.set()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await worker.queue_frames(
            [
                LLMFullResponseStartFrame(),
                TextFrame("Failed response."),
                LLMFullResponseEndFrame(),
            ]
        )
        await asyncio.wait_for(failed.wait(), 1)
        assert isinstance(errors[0].exception, error_type)
        assert not tts._audio_contexts
    finally:
        if not running.done():
            await worker.cancel()
        await asyncio.wait_for(running, 1)
