from __future__ import annotations

import asyncio
import base64
import io
import wave
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    MetricsFrame,
    TextFrame,
    TTSAudioRawFrame,
)
from pipecat.metrics.metrics import TTSUsageMetricsData
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from egma_simulator import preview as preview_module
from egma_simulator.model import PersonaReply
from egma_simulator.preview import preview_app, render_preview
from egma_simulator.redaction import REDACTED, SecretRegistry
from egma_simulator.speech import decode_speech, peak_level
from egma_simulator.usage import CLIENT_MEASURED, ProviderUsage


def request_body(*, gain: float = 1.0) -> dict:
    return {
        "requestId": "preview-1",
        "usageSettlementToken": "settlement-token",
        "text": "Hola",
        "models": {
            "llm": {
                "provider": "openai",
                "model": "preview-model",
                "adapter": "openai_chat_completions",
                "key": "model-key",
            },
            "tts": {
                "provider": "scripted",
                "model": "scripted",
                "adapter": "scripted",
                "voiceId": "plain",
                "speed": 1,
                "key": None,
            },
        },
        "controls": {
            "language": "es-MX",
            "emotion": "happy",
            "accent": "voice_default",
            "speechVolume": gain,
            "executionPolicyVersion": 1,
        },
    }


class PreviewModel:
    contexts = []

    async def reply(self, _context):
        self.contexts.append(_context)
        return PersonaReply(
            text="Hola",
            concluded=False,
            usage=ProviderUsage(
                provider="openai",
                model="preview-model",
                operation="openai_chat_completions",
                measurement=CLIENT_MEASURED,
                quantities={"output_tokens": 2},
            ),
        )

    async def close(self):
        return None


def use_preview_model(monkeypatch):
    monkeypatch.setattr(
        preview_module, "build_model_client", lambda _spec: PreviewModel()
    )


async def test_preview_uses_the_runtime_tts_and_gain_path(monkeypatch):
    use_preview_model(monkeypatch)
    normal = await render_preview(request_body())
    quiet = await render_preview(request_body(gain=0.5))

    def pcm(result: dict) -> bytes:
        with wave.open(io.BytesIO(base64.b64decode(result["audioBase64"]))) as audio:
            return audio.readframes(audio.getnframes())

    normal_pcm = pcm(normal)
    quiet_pcm = pcm(quiet)

    assert decode_speech(normal_pcm, 24_000) == "Hola"
    assert peak_level(quiet_pcm) == peak_level(normal_pcm) // 2
    assert [usage["quantities"] for usage in normal["usage"]] == [
        {"output_tokens": 2},
        {"characters": 4.0},
    ]
    assert normal["contentType"] == "audio/wav"
    prompt = PreviewModel.contexts[0].get_messages()[0]["content"]
    assert "Write it in es-MX" in prompt
    assert "Use happy wording" in prompt


async def test_slow_preview_is_cleanly_capped_at_ten_seconds(monkeypatch):
    use_preview_model(monkeypatch)

    class SlowPreviewTTS(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, TextFrame):
                await self.push_frame(
                    TTSAudioRawFrame(
                        bytes([1, 0]) * (24_000 * 12),
                        sample_rate=24_000,
                        num_channels=1,
                    )
                )
            await self.push_frame(frame, direction)

    async def close() -> None:
        return None

    monkeypatch.setattr(
        preview_module,
        "build_legs",
        lambda *_args, **_kwargs: SimpleNamespace(tts=SlowPreviewTTS(), aclose=close),
    )
    body = request_body()
    body["models"]["tts"]["speed"] = 0.25
    result = await render_preview(body)

    with wave.open(io.BytesIO(base64.b64decode(result["audioBase64"]))) as audio:
        assert audio.getnframes() == 24_000 * 10


async def test_preview_endpoint_requires_the_service_token(
    unused_tcp_port: int, monkeypatch
):
    use_preview_model(monkeypatch)
    runner = web.AppRunner(preview_app(service_token="internal-secret"))
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", unused_tcp_port).start()
    try:
        async with aiohttp.ClientSession() as session:
            refused = await session.post(
                f"http://127.0.0.1:{unused_tcp_port}/internal/persona-preview",
                json=request_body(),
            )
            accepted = await session.post(
                f"http://127.0.0.1:{unused_tcp_port}/internal/persona-preview",
                headers={"Authorization": "Bearer internal-secret"},
                json=request_body(),
            )
        assert refused.status == 401
        assert accepted.status == 200
    finally:
        await runner.cleanup()


async def test_preview_settles_usage_at_the_configured_control_plane(
    unused_tcp_port_factory, monkeypatch
):
    use_preview_model(monkeypatch)
    callback_port = unused_tcp_port_factory()
    preview_port = unused_tcp_port_factory()
    deliveries: list[tuple[str, dict]] = []

    async def settle(request: web.Request) -> web.Response:
        deliveries.append(
            (request.headers.get("Authorization", ""), await request.json())
        )
        if len(deliveries) == 1:
            raise web.HTTPInternalServerError()
        raise web.HTTPNoContent()

    callback_app = web.Application()
    callback_app.router.add_post("/internal/persona-preview-usage", settle)
    callback_runner = web.AppRunner(callback_app)
    await callback_runner.setup()
    await web.TCPSite(callback_runner, "127.0.0.1", callback_port).start()

    secrets = SecretRegistry()
    runner = web.AppRunner(
        preview_app(
            service_token="internal-secret",
            usage_callback_url=(
                f"http://127.0.0.1:{callback_port}/internal/persona-preview-usage"
            ),
            secrets=secrets,
        )
    )
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", preview_port).start()
    body = request_body()
    body["usageCallbackUrl"] = "https://attacker.invalid/collect"
    try:
        async with aiohttp.ClientSession() as session:
            response = await session.post(
                f"http://127.0.0.1:{preview_port}/internal/persona-preview",
                headers={"Authorization": "Bearer internal-secret"},
                json=body,
            )
        assert response.status == 200
    finally:
        await runner.cleanup()
        await callback_runner.cleanup()

    assert [event[1]["usageIndex"] for event in deliveries] == [0, 0, 1]
    assert deliveries[0] == deliveries[1]
    assert {authorization for authorization, _body in deliveries} == {
        "Bearer internal-secret"
    }
    assert all(event[1]["token"] == "settlement-token" for event in deliveries)
    assert secrets.redact("model-key settlement-token") == f"{REDACTED} {REDACTED}"


async def test_measured_llm_usage_settles_before_a_render_failure(monkeypatch):
    use_preview_model(monkeypatch)
    settled: list[tuple[int, ProviderUsage]] = []

    async def settle(index: int, usage: ProviderUsage) -> None:
        settled.append((index, usage))

    def fail_after_llm(*_args, **_kwargs):
        raise RuntimeError("TTS construction failed")

    monkeypatch.setattr(preview_module, "build_legs", fail_after_llm)
    body = request_body()
    body["_settle"] = settle
    with pytest.raises(RuntimeError, match="TTS construction failed"):
        await render_preview(body)

    assert [(index, usage.quantities) for index, usage in settled] == [
        (0, {"output_tokens": 2})
    ]


@pytest.mark.parametrize("audio_before_failure", [False, True])
async def test_preview_settles_tts_only_after_provider_audio(
    monkeypatch, audio_before_failure
):
    use_preview_model(monkeypatch)
    settled: list[tuple[int, ProviderUsage]] = []

    async def settle(index: int, usage: ProviderUsage) -> None:
        settled.append((index, usage))

    class FailingTTS(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, TextFrame):
                await self.push_frame(
                    MetricsFrame(
                        data=[
                            TTSUsageMetricsData(
                                processor="CartesiaTTSService",
                                model="sonic-3.6",
                                value=len(frame.text),
                            )
                        ]
                    )
                )
                if audio_before_failure:
                    await self.push_frame(
                        TTSAudioRawFrame(b"\x01\x00", 24_000, 1)
                    )
                await self.push_frame(ErrorFrame(error="provider refused synthesis"))
                return
            await self.push_frame(frame, direction)

    async def close() -> None:
        return None

    monkeypatch.setattr(
        preview_module,
        "build_legs",
        lambda *_args, **_kwargs: SimpleNamespace(tts=FailingTTS(), aclose=close),
    )
    body = request_body()
    body["models"]["tts"].update(
        {"provider": "cartesia", "adapter": "cartesia", "model": "sonic-3.6"}
    )
    body["_settle"] = settle

    with pytest.raises(RuntimeError, match="provider refused synthesis"):
        await render_preview(body)

    expected = [(0, {"output_tokens": 2})]
    if audio_before_failure:
        expected.append((1, {"characters": 4.0}))
    assert [(index, usage.quantities) for index, usage in settled] == expected


@pytest.mark.parametrize("audio_before_cancel", [False, True])
async def test_preview_cancellation_settles_only_observed_provider_work(
    monkeypatch, audio_before_cancel
):
    use_preview_model(monkeypatch)
    entered = asyncio.Event()
    closed = asyncio.Event()
    settled: list[tuple[int, ProviderUsage]] = []

    async def settle(index: int, usage: ProviderUsage) -> None:
        settled.append((index, usage))

    class PendingTTS(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, TextFrame):
                await self.push_frame(
                    MetricsFrame(
                        data=[
                            TTSUsageMetricsData(
                                processor="CartesiaTTSService",
                                model="sonic-3.6",
                                value=len(frame.text),
                            )
                        ]
                    )
                )
                if audio_before_cancel:
                    await self.push_frame(
                        TTSAudioRawFrame(b"\x01\x00", 24_000, 1)
                    )
                entered.set()
                await asyncio.Event().wait()
            await self.push_frame(frame, direction)

    async def close() -> None:
        closed.set()

    monkeypatch.setattr(
        preview_module,
        "build_legs",
        lambda *_args, **_kwargs: SimpleNamespace(tts=PendingTTS(), aclose=close),
    )
    body = request_body()
    body["_settle"] = settle
    rendering = asyncio.create_task(render_preview(body))
    await entered.wait()
    rendering.cancel()
    with pytest.raises(asyncio.CancelledError):
        await rendering

    expected = [(0, {"output_tokens": 2})]
    if audio_before_cancel:
        expected.append((1, {"characters": 4.0}))
    assert [(index, usage.quantities) for index, usage in settled] == expected
    assert closed.is_set()


async def test_bounded_settlement_survives_client_task_cancellation():
    started = asyncio.Event()
    release = asyncio.Event()
    delivered: list[int] = []

    async def settle(index: int, _usage: ProviderUsage) -> None:
        started.set()
        await release.wait()
        delivered.append(index)

    usage = ProviderUsage(
        provider="openai",
        model="preview-model",
        operation="openai_chat_completions",
        measurement=CLIENT_MEASURED,
        quantities={"output_tokens": 2},
    )
    task = asyncio.create_task(preview_module._settle_shielded(settle, 0, usage))
    await started.wait()
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert delivered == [0]
