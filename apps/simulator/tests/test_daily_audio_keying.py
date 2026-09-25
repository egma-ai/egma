"""Pin how Pipecat's Daily transport keys inbound audio, per participant and source.

Pipecat's LiveKit transport kept one audio stream per participant, so an
agent's second track closed its first; the simulator replaces that reader
(media/room.py). The Daily transport of the pinned Pipecat keeps one renderer
per participant and audio source, and captures every joining participant's
microphone. These tests fail if an upgrade brings the LiveKit defect to Daily.
"""

from __future__ import annotations

from importlib.metadata import version
from typing import Any

from pipecat.transports.daily.transport import DailyTransport, DailyTransportClient

PINNED_PIPECAT = "1.9.0"


class _NativeClient:
    """The daily-python CallClient calls the transport makes, recorded."""

    def __init__(self) -> None:
        self.renderers: list[tuple[str, str]] = []

    def set_audio_renderer(
        self,
        participant_id: str,
        callback: Any,
        *,
        audio_source: str,
        sample_rate: int,
        callback_interval_ms: int,
    ) -> None:
        del callback, sample_rate, callback_interval_ms
        self.renderers.append((participant_id, audio_source))


class _TransportClient:
    """The attributes DailyTransportClient's audio methods read, without Daily."""

    def __init__(self) -> None:
        self._audio_renderers: dict[str, dict[str, Any]] = {}
        self._client = _NativeClient()
        self.subscriptions: list[dict[str, Any]] = []
        self.delivered: list[tuple[Any, tuple[Any, ...]]] = []

    async def update_subscriptions(self, participant_settings: dict[str, Any]) -> None:
        self.subscriptions.append(participant_settings)

    def _call_audio_callback(self, callback: Any, *args: Any) -> None:
        self.delivered.append((callback, args))

    def _audio_data_received(self, *args: Any) -> None:
        DailyTransportClient._audio_data_received(self, *args)  # type: ignore[arg-type]


def test_the_pinned_pipecat_is_the_one_these_tests_read():
    assert version("pipecat-ai") == PINNED_PIPECAT


async def test_a_second_audio_source_does_not_replace_the_first():
    client = _TransportClient()

    async def voice(*_args: Any) -> None: ...

    async def backing(*_args: Any) -> None: ...

    await DailyTransportClient.capture_participant_audio(
        client, "bot", voice, "microphone", 16000
    )
    await DailyTransportClient.capture_participant_audio(
        client, "bot", backing, "background", 16000
    )

    assert client._audio_renderers == {
        "bot": {"microphone": voice, "background": backing}
    }
    assert client._client.renderers == [("bot", "microphone"), ("bot", "background")]

    client._audio_data_received("bot", "voice-frame", "microphone")
    client._audio_data_received("bot", "backing-frame", "background")
    assert client.delivered == [
        (voice, ("bot", "voice-frame", "microphone")),
        (backing, ("bot", "backing-frame", "background")),
    ]


async def test_capturing_one_source_again_replaces_only_that_source():
    client = _TransportClient()

    async def first(*_args: Any) -> None: ...

    async def second(*_args: Any) -> None: ...

    await DailyTransportClient.capture_participant_audio(
        client, "bot", first, "microphone", 16000
    )
    await DailyTransportClient.capture_participant_audio(
        client, "bot", second, "microphone", 16000
    )

    assert client._audio_renderers == {"bot": {"microphone": second}}


async def test_every_joining_participant_has_its_microphone_captured():
    """The persona hears an agent that joined before it, and one that joins after.

    A live probe on 2026-09-23 (daily-python 0.32.0) showed that a client
    joining second receives on_participant_joined for a participant already in
    the room, so this one handler covers both orders of arrival.
    """
    captured: list[tuple[str, str, int]] = []

    class _Input:
        async def capture_participant_audio(
            self, participant_id: str, audio_source: str, sample_rate: int
        ) -> None:
            captured.append((participant_id, audio_source, sample_rate))

        async def push_frame(self, _frame: Any) -> None: ...

    class _Params:
        audio_in_enabled = True
        audio_in_user_tracks = True

    class _Client:
        in_sample_rate = 16000

    class _Transport:
        _input = _Input()
        _params = _Params()
        _client = _Client()
        _other_participant_has_joined = False

        async def _call_event_handler(self, *_args: Any) -> None: ...

    await DailyTransport._on_participant_joined(_Transport(), {"id": "bot-a"})
    await DailyTransport._on_participant_joined(_Transport(), {"id": "bot-b"})

    assert captured == [("bot-a", "microphone", 16000), ("bot-b", "microphone", 16000)]
