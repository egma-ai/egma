"""Authenticated short persona audio rendered by the simulator's real mouth."""

from __future__ import annotations

import asyncio
import base64
import hmac
from dataclasses import asdict

from aiohttp import web
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TextFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from .spec import (
    ModelSelection,
    PersonaParameters,
    SelectedModels,
    SpeechSelection,
)
from .speech import SpeechGain, SpeechProviders, build_legs, voice_from_models
from .usage import characters_usage

MAX_BODY_BYTES = 16 * 1024
MAX_TEXT_CHARACTERS = 500
PREVIEW_SECONDS = 15
PREVIEW_SAMPLE_RATE = 24_000


class _AudioCollector(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.audio = bytearray()
        self.sample_rate = 0
        self.finished = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            if self.sample_rate and self.sample_rate != frame.sample_rate:
                raise ValueError("preview TTS changed sample rate during one response")
            self.sample_rate = frame.sample_rate
            self.audio.extend(frame.audio)
        elif isinstance(frame, TTSStoppedFrame):
            self.finished.set()
        await self.push_frame(frame, direction)


async def render_preview(body: dict) -> dict:
    """Render one bounded sample through the same TTS and speech-gain processors."""
    text = body["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARACTERS:
        raise ValueError(f"text must contain 1–{MAX_TEXT_CHARACTERS} characters")
    selected = body["models"]["tts"]
    controls = body["controls"]
    parameters = PersonaParameters(
        language=controls["language"],
        emotion=controls["emotion"],
        accent=controls["accent"],
        speech_volume=float(controls["speechVolume"]),
        execution_policy_version=int(controls["executionPolicyVersion"]),
    )
    models = SelectedModels(
        llm=ModelSelection(provider="preview", model="preview", adapter="preview"),
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
    usage = characters_usage(
        len(text),
        provider=selected["provider"],
        model=selected["model"],
        operation=selected["adapter"],
    )
    return {
        "audioBase64": base64.b64encode(collector.audio).decode(),
        "contentType": (
            f"audio/L16;rate={collector.sample_rate or PREVIEW_SAMPLE_RATE};channels=1"
        ),
        "usage": None if usage is None else asdict(usage),
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
            async with semaphore:
                result = await asyncio.wait_for(render_preview(body), PREVIEW_SECONDS)
        except (KeyError, TypeError, ValueError) as fault:
            raise web.HTTPBadRequest(text=str(fault)) from fault
        except TimeoutError as fault:
            raise web.HTTPGatewayTimeout(text="persona preview timed out") from fault
        return web.json_response(result)

    app = web.Application(client_max_size=MAX_BODY_BYTES)
    app.router.add_post("/internal/persona-preview", preview)
    return app


async def start_preview_server(*, service_token: str, port: int) -> web.AppRunner:
    runner = web.AppRunner(preview_app(service_token=service_token))
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", port).start()
    return runner
