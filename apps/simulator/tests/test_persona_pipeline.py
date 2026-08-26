"""The persona model as a real Pipecat service in the final voice path."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from fractions import Fraction

import aiohttp
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TextAggregationMode, TTSService
from pipecat.utils.tracing.service_decorators import traced_tts
from pipecat.workers.runner import WorkerRunner

from egma_simulator.conductor import (
    _AgentFinished,
    _PersonaBrain,
    _PersonaLLMService,
    _PersonaReplyGate,
)
from egma_simulator.model import (
    PERSONA_TOOLS,
    ModelFailure,
    OpenAICompatibleModel,
    PersonaReply,
    PersonaToolCall,
)
from egma_simulator.persona import OPENING_NUDGE, Persona, Turn
from egma_simulator.spans import SpanEmitter, trace_id_for
from egma_simulator.spec import AuthoredPersona
from egma_simulator.speech import (
    PersonaVoice,
    SpeechProviders,
    build_legs,
    decode_speech,
    encode_speech,
)

AUTHORED = AuthoredPersona(
    name="Alex", personality="Patient.", language="en-US"
)

SECRET = "egma-secret-must-not-enter-telemetry"


class SecretModel:
    """A ModelClient whose credential must stay behind the service seam."""

    model_name = "safe-test-model"

    def __init__(self) -> None:
        self.api_key = SECRET
        self.contexts: list[LLMContext] = []
        self.messages: list[list[dict[str, str]]] = []
        self.replies = [
            PersonaReply("First response.", concluded=False),
            PersonaReply(
                "Goodbye.",
                concluded=False,
                tool_calls=(
                    PersonaToolCall(
                        tool_call_id="call_end",
                        name="end_call",
                        arguments={},
                    ),
                ),
            ),
        ]

    async def reply(self, context: LLMContext) -> PersonaReply:
        self.contexts.append(context)
        self.messages.append(context.get_messages())
        return self.replies.pop(0)

    async def close(self) -> None:
        return None


class EchoSession:
    """The smallest aiohttp-shaped refusal, with no network or live provider."""

    def post(self, *_args: object, **_kwargs: object) -> None:
        # The original exception becomes traceback context unless ModelClient
        # suppresses it. Pipecat records the whole formatted traceback.
        raise aiohttp.ClientConnectionError(f"provider echoed {SECRET}")

    async def close(self) -> None:
        return None


class SuccessfulEchoResponse:
    status = 200

    async def __aenter__(self) -> SuccessfulEchoResponse:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def json(self) -> dict:
        return {"choices": [{"message": {"content": f"Provider echoed {SECRET}."}}]}


class SuccessfulEchoSession:
    def post(self, *_args: object, **_kwargs: object) -> SuccessfulEchoResponse:
        return SuccessfulEchoResponse()

    async def close(self) -> None:
        return None


class StockTTSResponse:
    """A provider-shaped PCM response for Pipecat's stock OpenAI service."""

    status_code = 200

    def __init__(self, text: str) -> None:
        self.text_to_speak = text

    async def __aenter__(self) -> StockTTSResponse:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def text(self) -> str:
        return ""

    async def iter_bytes(self, _chunk_size: int) -> AsyncGenerator[bytes, None]:
        yield encode_speech(self.text_to_speak, 24_000)


class StockTTSStreamingResponses:
    def create(self, **request: object) -> StockTTSResponse:
        return StockTTSResponse(str(request["input"]))


class StockTTSSpeech:
    def __init__(self) -> None:
        self.with_streaming_response = StockTTSStreamingResponses()


class StockTTSAudio:
    def __init__(self) -> None:
        self.speech = StockTTSSpeech()


class StockTTSClient:
    def __init__(self) -> None:
        self.audio = StockTTSAudio()


class ConductorProbe:
    def __init__(self) -> None:
        self.history: list[Turn] = []
        self.spoken: list[str] = []
        self.concluded: list[str] = []
        self.failures: list[BaseException] = []
        self.ended = asyncio.Event()

    @property
    def is_ending(self) -> bool:
        return bool(self.concluded)

    async def the_agent_finished(
        self, said: str, heard_a_turn: bool
    ) -> Fraction | None:
        if heard_a_turn:
            self.history.append(Turn("agent", said))
        return Fraction(0)

    async def wait_until(self, _due: Fraction) -> None:
        return None

    def persona_will_speak(self, text: str, *, concludes: bool = False) -> None:
        self.spoken.append(text)
        self.history.append(Turn("human", text))
        if concludes:
            self.concluded.append(text)
            self.ended.set()

    def the_brain_failed(self, fault: BaseException) -> None:
        self.failures.append(fault)
        self.ended.set()


class OutputProbe(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.responded = asyncio.Event()
        self.final_responded = asyncio.Event()
        self.response_count = 0
        self.transcribed = asyncio.Event()
        self.frames: list[Frame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        self.frames.append(frame)
        if isinstance(frame, StartFrame):
            self.started.set()
        elif isinstance(frame, TranscriptionFrame):
            self.transcribed.set()
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.response_count += 1
            self.responded.set()
            if self.response_count == 2:
                self.final_responded.set()
        await self.push_frame(frame, direction)


class DeterministicTTSService(TTSService):
    """A network-free Pipecat TTS lifecycle for the native decorator proof."""

    def __init__(self) -> None:
        super().__init__(
            text_aggregation_mode=TextAggregationMode.TOKEN,
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=16_000,
            settings=TTSSettings(
                model="deterministic-test-tts",
                voice="deterministic-test-voice",
                language=None,
            ),
        )

    @traced_tts
    async def run_tts(
        self, text: str, context_id: str
    ) -> AsyncGenerator[Frame | None, None]:
        yield TTSAudioRawFrame(
            audio=encode_speech(text, self.sample_rate),
            sample_rate=self.sample_rate,
            num_channels=1,
            context_id=context_id,
        )


def spans_in(documents: list[bytes]) -> list[tuple[str, dict]]:
    found: list[tuple[str, dict]] = []
    for serialized in documents:
        document = json.loads(serialized)
        for resource in document["resourceSpans"]:
            for scoped in resource["scopeSpans"]:
                for span in scoped["spans"]:
                    found.append((scoped["scope"]["name"], span))
    return found


def attribute(span: dict, key: str) -> object | None:
    for item in span.get("attributes", []):
        if item["key"] != key:
            continue
        return next(iter(item["value"].values()))
    return None


async def test_the_final_persona_pipeline_uses_pipecats_native_service_spans(
    monkeypatch,
):
    model = SecretModel()
    persona = Persona(
        authored=AUTHORED,
        scenario_instructions="Ask one safe question.",
        model=model,
    )
    conductor = ConductorProbe()
    service = _PersonaLLMService(persona=persona)
    gate = _PersonaReplyGate(service=service, conductor=conductor)
    brain = _PersonaBrain(persona=persona, conductor=conductor, replies=gate)
    legs = build_legs(
        SpeechProviders(
            stt="scripted",
            tts="openai",
            tts_key=SECRET,
            tts_model="gpt-4o-mini-tts",
        ),
        voice=PersonaVoice(voice_id="alloy", provider="openai", speed=1.0),
    )
    stt = legs.stt
    tts = legs.tts
    assert type(stt).__name__ == "ScriptedSTT"
    assert type(tts).__name__ == "OpenAITTSService"

    # The production builder made the real Pipecat services. Replace only
    # their provider I/O so this proof stays deterministic and network-free;
    # their StartFrame, audio-context, decorator, and frame paths remain stock.
    await tts._client.close()  # type: ignore[attr-defined]
    monkeypatch.setattr(tts, "_client", StockTTSClient())
    output = OutputProbe()

    documents: list[bytes] = []
    evidence = SpanEmitter("sim-native-model", flush=documents.append)
    evidence.opened()

    worker = PipelineWorker(
        Pipeline([stt, brain, service, gate, tts, output]),
        params=PipelineParams(),
        idle_timeout_secs=None,
        enable_tracing=True,
        enable_turn_tracking=False,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(output.started.wait(), timeout=2)

        await worker.queue_frame(_AgentFinished(heard_a_turn=False))
        await asyncio.wait_for(output.responded.wait(), timeout=2)
        spoken = [frame.text for frame in output.frames if isinstance(frame, TextFrame)]
        assert spoken
        assert set(spoken) == {"First response."}

        await worker.queue_frame(VADUserStartedSpeakingFrame())
        await worker.queue_frame(
            InputAudioRawFrame(
                audio=encode_speech("Anything else?", 16_000),
                sample_rate=16_000,
                num_channels=1,
            )
        )
        await worker.queue_frame(VADUserStoppedSpeakingFrame())
        await asyncio.wait_for(output.transcribed.wait(), timeout=2)
        await worker.queue_frame(_AgentFinished())
        await asyncio.wait_for(output.final_responded.wait(), timeout=2)
        assert conductor.concluded == ["Goodbye."]
        spoken = [frame.text for frame in output.frames if isinstance(frame, TextFrame)]
        assert "Goodbye." in spoken
        assert conductor.failures == []
    finally:
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, timeout=2)
        await legs.aclose()

    # The root stays attached until every service task has ended.
    evidence.sealed()

    assert model.messages[0][1] == {"role": "user", "content": OPENING_NUDGE}
    assert all(context.tools is PERSONA_TOOLS for context in model.contexts)
    assert all(context.tool_choice == "auto" for context in model.contexts)
    assert model.messages[1][-2:] == [
        {"role": "assistant", "content": "First response."},
        {"role": "user", "content": "Anything else?"},
    ]

    exported = spans_in(documents)
    root = next(span for scope, span in exported if scope == "egma-simulator")
    native = [span for scope, span in exported if scope == "pipecat"]
    assert [span["name"] for span in native].count("llm") == 2
    assert [span["name"] for span in native].count("stt") == 1
    assert [span["name"] for span in native].count("tts") == 2
    assert {span["traceId"] for span in native} == {trace_id_for("sim-native-model")}
    assert {span["parentSpanId"] for span in native} == {root["spanId"]}
    model_spans = [span for span in native if span["name"] == "llm"]
    assert [attribute(span, "output") for span in model_spans] == [
        "First response.",
        "Goodbye.",
    ]
    # Pipecat 1.7's decorator states its own service semantic here. The model
    # client's HTTP request remains non-streaming; Egma preserves this native
    # attribute instead of rewriting it to describe a different layer.
    assert {attribute(span, "stream") for span in model_spans} == {True}
    stt_span = next(span for span in native if span["name"] == "stt")
    tts_spans = [span for span in native if span["name"] == "tts"]
    assert attribute(stt_span, "transcript") == "Anything else?"
    assert [attribute(span, "text") for span in tts_spans] == [
        "First response.",
        "Goodbye.",
    ]
    assert SECRET.encode() not in b"\n".join(documents)
    assert any(
        attribute(span, "gen_ai.request.model") == model.model_name for span in native
    )
    pipecat_scopes = [
        scoped["scope"]
        for serialized in documents
        for resource in json.loads(serialized)["resourceSpans"]
        for scoped in resource["scopeSpans"]
        if scoped["scope"]["name"] == "pipecat"
    ]
    assert all(scope == {"name": "pipecat"} for scope in pipecat_scopes)


async def test_a_provider_cannot_echo_its_key_into_the_native_model_span():
    model = OpenAICompatibleModel(
        base_url="https://provider.invalid/v1",
        api_key=SECRET,
        model_name="safe-test-model",
    )
    model._session = EchoSession()  # type: ignore[assignment]
    persona = Persona(
        authored=AUTHORED,
        scenario_instructions="Ask safely.",
        model=model,
    )
    conductor = ConductorProbe()
    service = _PersonaLLMService(persona=persona)
    gate = _PersonaReplyGate(service=service, conductor=conductor)
    brain = _PersonaBrain(persona=persona, conductor=conductor, replies=gate)
    output = OutputProbe()

    documents: list[bytes] = []
    evidence = SpanEmitter("sim-native-model-failure", flush=documents.append)
    evidence.opened()
    worker = PipelineWorker(
        Pipeline([brain, service, gate, output]),
        params=PipelineParams(),
        idle_timeout_secs=None,
        enable_tracing=True,
        enable_turn_tracking=False,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(output.started.wait(), timeout=2)
        await worker.queue_frame(_AgentFinished(heard_a_turn=False))
        await asyncio.wait_for(conductor.ended.wait(), timeout=2)
    finally:
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, timeout=2)
        await model.close()
    evidence.sealed()

    (failure,) = conductor.failures
    assert isinstance(failure, ModelFailure)
    assert "[redacted]" in str(failure)
    serialized = b"\n".join(documents)
    assert SECRET.encode() not in serialized
    assert b"[redacted]" in serialized


async def test_a_successful_provider_cannot_echo_its_key_to_voice_or_evidence():
    model = OpenAICompatibleModel(
        base_url="https://provider.invalid/v1",
        api_key=SECRET,
        model_name="safe-test-model",
    )
    model._session = SuccessfulEchoSession()  # type: ignore[assignment]
    persona = Persona(
        authored=AUTHORED,
        scenario_instructions="Ask safely.",
        model=model,
    )
    conductor = ConductorProbe()
    service = _PersonaLLMService(persona=persona)
    gate = _PersonaReplyGate(service=service, conductor=conductor)
    brain = _PersonaBrain(persona=persona, conductor=conductor, replies=gate)
    tts = DeterministicTTSService()
    output = OutputProbe()

    documents: list[bytes] = []
    evidence = SpanEmitter("sim-native-model-success", flush=documents.append)
    evidence.opened()
    worker = PipelineWorker(
        Pipeline([brain, service, gate, tts, output]),
        params=PipelineParams(),
        idle_timeout_secs=None,
        enable_tracing=True,
        enable_turn_tracking=False,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(output.started.wait(), timeout=2)
        await worker.queue_frame(_AgentFinished(heard_a_turn=False))
        await asyncio.wait_for(output.responded.wait(), timeout=2)
    finally:
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, timeout=2)
        await model.close()
    evidence.sealed()

    safe_reply = "Provider echoed [redacted]."
    assert conductor.spoken == [safe_reply]
    audio = b"".join(
        frame.audio for frame in output.frames if isinstance(frame, TTSAudioRawFrame)
    )
    assert decode_speech(audio, 16_000) == safe_reply
    serialized = b"\n".join(documents)
    assert SECRET.encode() not in serialized
    model_span = next(
        span
        for scope, span in spans_in(documents)
        if scope == "pipecat" and span["name"] == "llm"
    )
    assert attribute(model_span, "output") == safe_reply
