"""Authenticated short persona audio rendered by the simulator's real mouth."""

from __future__ import annotations

import asyncio
import base64
import hmac
import io
import wave
from dataclasses import asdict
from types import SimpleNamespace

from aiohttp import web
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    MetricsFrame,
    TextFrame,
    TTSAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from .model import build_model_client
from .spec import (
    ModelSelection,
    PersonaParameters,
    SelectedModels,
    SpeechSelection,
)
from .speech import (
    ProviderUsageMetricsData,
    SpeechGain,
    SpeechProviders,
    build_legs,
    voice_from_models,
)
from .usage import ProviderUsage, characters_usage

MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_CHARACTERS = 500
PREVIEW_SECONDS = 15
PREVIEW_SAMPLE_RATE = 24_000
MAX_AUDIO_SECONDS = 10

_EMOTIONAL_WORDING = {
    "neutral": "Use neutral wording.",
    "happy": "Use happy wording.",
    "angry": "Use angry wording.",
    "frustrated": "Use frustrated wording.",
    "sad": "Use sad wording.",
    "anxious": "Use anxious wording.",
}


async def _preview_text(
    models: SelectedModels, parameters: PersonaParameters
) -> tuple[str, ProviderUsage | None]:
    """Ask the selected LLM for the short sample the selected voice will speak."""
    instruction = _EMOTIONAL_WORDING.get(parameters.emotion)
    if instruction is None:
        raise ValueError("emotion is not supported")
    prompt = (
        "Write exactly one scenario-neutral sentence for a voice preview. "
        f"Write it in {parameters.language}. {instruction} "
        "Use 8 to 16 words. Return only that sentence."
    )
    model = build_model_client(SimpleNamespace(models=models, runtime=None))
    try:
        reply = await model.reply(
            LLMContext(messages=[{"role": "system", "content": prompt}])
        )
    finally:
        await model.close()
    if not reply.text or len(reply.text) > MAX_TEXT_CHARACTERS:
        raise ValueError("the preview model did not return one short sentence")
    return reply.text, reply.usage


class _AudioCollector(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.audio = bytearray()
        self.sample_rate = 0
        self.finished = asyncio.Event()
        self.usage: ProviderUsage | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            if self.sample_rate and self.sample_rate != frame.sample_rate:
                raise ValueError("preview TTS changed sample rate during one response")
            self.sample_rate = frame.sample_rate
            self.audio.extend(frame.audio)
            if len(self.audio) > self.sample_rate * 2 * MAX_AUDIO_SECONDS:
                raise ValueError("persona preview exceeded 10 seconds of audio")
        elif isinstance(frame, MetricsFrame):
            for metric in frame.data:
                if isinstance(metric, ProviderUsageMetricsData):
                    self.usage = metric.usage
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.finished.set()
        await self.push_frame(frame, direction)


async def render_preview(body: dict) -> dict:
    """Render one bounded sample through the same TTS and speech-gain processors."""
    selected = body["models"]["tts"]
    selected_llm = body["models"]["llm"]
    controls = body["controls"]
    parameters = PersonaParameters(
        language=controls["language"],
        emotion=controls["emotion"],
        accent=controls["accent"],
        speech_volume=float(controls["speechVolume"]),
        execution_policy_version=int(controls["executionPolicyVersion"]),
    )
    models = SelectedModels(
        llm=ModelSelection(
            provider=selected_llm["provider"],
            model=selected_llm["model"],
            adapter=selected_llm["adapter"],
            key=selected_llm["key"],
            funding_receipt=selected_llm.get("fundingReceipt"),
        ),
        stt=ModelSelection(provider="scripted", model="scripted", adapter="scripted"),
        tts=SpeechSelection(
            provider=selected["provider"],
            model=selected["model"],
            adapter=selected["adapter"],
            key=selected["key"],
            funding_receipt=selected.get("fundingReceipt"),
            voice_id=selected["voiceId"],
            speed=float(selected["speed"]),
        ),
    )
    text, llm_usage = await _preview_text(models, parameters)
    providers = SpeechProviders.from_models(models, vad="scripted")
    legs = build_legs(providers, voice=voice_from_models(models, parameters))
    collector = _AudioCollector()
    worker = PipelineWorker(
        Pipeline([legs.tts, SpeechGain(parameters.speech_volume), collector]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await worker.queue_frames(
            [LLMFullResponseStartFrame(), TextFrame(text), LLMFullResponseEndFrame()]
        )
        await asyncio.wait_for(collector.finished.wait(), PREVIEW_SECONDS)
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 2)
    finally:
        if not running.done():
            await worker.cancel()
            await running
        await legs.aclose()
    tts_usage = collector.usage
    if tts_usage is None and selected["provider"] in {"cartesia", "scripted"}:
        tts_usage = characters_usage(
            len(text),
            provider=selected["provider"],
            model=selected["model"],
            operation=selected["adapter"],
        )
    wav = io.BytesIO()
    with wave.open(wav, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(collector.sample_rate or PREVIEW_SAMPLE_RATE)
        output.writeframes(collector.audio)
    return {
        "audioBase64": base64.b64encode(wav.getvalue()).decode(),
        "contentType": "audio/wav",
        "usage": [asdict(item) for item in (llm_usage, tts_usage) if item is not None],
    }


def preview_app(*, service_token: str, concurrency: int = 2) -> web.Application:
    semaphore = asyncio.Semaphore(concurrency)

    async def preview(request: web.Request) -> web.Response:
        authorization = request.headers.get("Authorization", "")
        if not hmac.compare_digest(authorization, f"Bearer {service_token}"):
            raise web.HTTPUnauthorized()
        if (
            request.content_length is not None
            and request.content_length > MAX_BODY_BYTES
        ):
            raise web.HTTPRequestEntityTooLarge(
                max_size=MAX_BODY_BYTES, actual_size=request.content_length
            )
        try:
            body = await request.json()
            if semaphore.locked():
                raise web.HTTPServiceUnavailable(text="persona preview is busy")

            async def admitted() -> dict:
                async with semaphore:
                    return await render_preview(body)

            result = await asyncio.wait_for(admitted(), PREVIEW_SECONDS)
        except (KeyError, TypeError, ValueError) as fault:
            raise web.HTTPBadRequest(text=str(fault)) from fault
        except TimeoutError as fault:
            raise web.HTTPGatewayTimeout(text="persona preview timed out") from fault
        return web.json_response(result)

    app = web.Application(client_max_size=MAX_BODY_BYTES)
    app.router.add_post("/internal/persona-preview", preview)
    return app


async def start_preview_server(*, service_token: str, port: int) -> web.AppRunner:
    runner = web.AppRunner(
        preview_app(service_token=service_token), handler_cancellation=True
    )
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", port).start()
    return runner
