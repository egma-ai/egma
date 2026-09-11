"""Authenticated short persona audio rendered by the simulator's real mouth."""

from __future__ import annotations

import asyncio
import base64
import hmac
import io
import wave
from dataclasses import asdict
from types import SimpleNamespace

import aiohttp
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

from .background import BackgroundSound, soundfile_mixer
from .model import build_model_client
from .redaction import SecretRegistry
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
SETTLEMENT_SECONDS = 2


async def _settle_shielded(settle, index: int, usage: ProviderUsage) -> None:
    """Finish one bounded usage delivery even if the Preview client leaves."""
    delivery = asyncio.create_task(settle(index, usage))
    try:
        await asyncio.shield(delivery)
    except asyncio.CancelledError:
        try:
            await delivery
        finally:
            raise


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
        self.capped = False
        self.usage: ProviderUsage | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            if self.sample_rate and self.sample_rate != frame.sample_rate:
                raise ValueError("preview TTS changed sample rate during one response")
            self.sample_rate = frame.sample_rate
            limit = self.sample_rate * 2 * MAX_AUDIO_SECONDS
            remaining = max(0, limit - len(self.audio))
            self.audio.extend(frame.audio[:remaining])
            if len(frame.audio) > remaining or len(self.audio) == limit:
                self.capped = True
                self.finished.set()
        elif isinstance(frame, MetricsFrame):
            for metric in frame.data:
                if isinstance(metric, ProviderUsageMetricsData):
                    self.usage = metric.usage
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.finished.set()
        await self.push_frame(frame, direction)


class _BackgroundMix(FrameProcessor):
    """Use the same Pipecat mixer as calls for the finite Preview sample."""

    def __init__(self, mixer) -> None:
        super().__init__()
        self._mixer = mixer

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            frame.audio = await self._mixer.mix(frame.audio)
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
        background_sound_id=controls.get("backgroundSoundId", "none"),
        background_volume=float(controls.get("backgroundVolume", 0.0631)),
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
    settle = body.get("_settle")
    if llm_usage is not None and callable(settle):
        await _settle_shielded(settle, 0, llm_usage)
    providers = SpeechProviders.from_models(models, vad="scripted")
    legs = build_legs(providers, voice=voice_from_models(models, parameters))
    collector = _AudioCollector()
    mixer = None
    running: asyncio.Task | None = None
    render_failure: BaseException | None = None
    try:
        mixer = soundfile_mixer(
            BackgroundSound(
                parameters.background_sound_id, parameters.background_volume
            )
        )
        if mixer is not None:
            await mixer.start(PREVIEW_SAMPLE_RATE)
        audio_processors = [] if mixer is None else [_BackgroundMix(mixer)]
        worker = PipelineWorker(
            Pipeline(
                [
                    legs.tts,
                    SpeechGain(parameters.speech_volume),
                    *audio_processors,
                    collector,
                ]
            ),
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
                [
                    LLMFullResponseStartFrame(),
                    TextFrame(text),
                    LLMFullResponseEndFrame(),
                ]
            )
            await asyncio.wait_for(collector.finished.wait(), PREVIEW_SECONDS)
            if collector.capped:
                await worker.cancel()
            else:
                await worker.queue_frame(EndFrame())
            await asyncio.wait_for(running, 2)
        except BaseException as fault:
            render_failure = fault
        finally:
            if not running.done():
                await worker.cancel()
                await running
    finally:
        await legs.aclose()
        if mixer is not None:
            await mixer.stop()
    tts_usage = collector.usage
    if tts_usage is None:
        tts_usage = characters_usage(
            len(text),
            provider=selected["provider"],
            model=selected["model"],
            operation=selected["adapter"],
        )
    if tts_usage is not None and callable(settle):
        await _settle_shielded(settle, 1, tts_usage)
    if render_failure is not None:
        raise render_failure
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


def preview_app(
    *,
    service_token: str,
    usage_callback_url: str | None = None,
    secrets: SecretRegistry | None = None,
    concurrency: int = 2,
) -> web.Application:
    semaphore = asyncio.Semaphore(concurrency)
    secret_registry = secrets or SecretRegistry()

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
            secret_registry.register(
                [body.get("usageSettlementToken"), body.get("models")]
            )
            for required in ("requestId", "usageSettlementToken"):
                if not isinstance(body.get(required), str) or not body[required]:
                    raise ValueError(f"{required} is required")

            async def settle(index: int, usage: ProviderUsage) -> None:
                if usage_callback_url is None:
                    return
                payload = {
                    "token": body["usageSettlementToken"],
                    "usageIndex": index,
                    "usage": asdict(usage),
                }
                timeout = aiohttp.ClientTimeout(total=SETTLEMENT_SECONDS)
                for attempt in range(2):
                    try:
                        async with aiohttp.ClientSession(timeout=timeout) as session:
                            async with session.post(
                                usage_callback_url,
                                json=payload,
                                headers={"Authorization": f"Bearer {service_token}"},
                            ) as response:
                                if 200 <= response.status < 300:
                                    return
                                if (
                                    response.status not in (408, 429)
                                    and response.status < 500
                                ):
                                    raise ValueError(
                                        "preview usage settlement was refused "
                                        f"({response.status})"
                                    )
                    except (aiohttp.ClientError, TimeoutError):
                        if attempt:
                            raise
                raise RuntimeError("preview usage settlement failed")

            body["_settle"] = settle
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


async def start_preview_server(
    *,
    service_token: str,
    usage_callback_url: str,
    secrets: SecretRegistry,
    port: int,
) -> web.AppRunner:
    runner = web.AppRunner(
        preview_app(
            service_token=service_token,
            usage_callback_url=usage_callback_url,
            secrets=secrets,
        ),
        handler_cancellation=True,
    )
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", port).start()
    return runner
