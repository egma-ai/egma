from __future__ import annotations

import base64
import io
import wave

import aiohttp
from aiohttp import web

from egma_simulator import preview as preview_module
from egma_simulator.model import PersonaReply
from egma_simulator.preview import preview_app, render_preview
from egma_simulator.speech import decode_speech, peak_level
from egma_simulator.usage import CLIENT_MEASURED, ProviderUsage


def request_body(*, gain: float = 1.0) -> dict:
    return {
        "requestId": "preview-1",
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
            }
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
