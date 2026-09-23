"""Opt-in: the Daily lane in a real Daily room, against a scripted RTVI bot.

Run: uv run pytest tests/test_live_daily_room.py -v
Set TEST_DAILY_API_KEY (or DAILY_API_KEY). The test creates a short-lived room
with Daily's REST API, joins a daily-python "bot" that publishes a tone and
answers RTVI like a Pipecat bot, and drives the production chat room
(daily-python call client) and voice room (Pipecat's Daily transport) into it.
The start request and the agent report are the only doubles.
"""

from __future__ import annotations

import asyncio
import json
import math
import struct
import threading
import time
import urllib.request
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from conftest import credential

from egma_simulator.media import RemoteParticipantLeftFrame
from egma_simulator.media.daily_room import (
    AgentReport,
    DailyWayIn,
    PipecatChatBackend,
    PipecatVoiceBackend,
    StartSettings,
)

DAILY_API_KEY = credential("TEST_DAILY_API_KEY", "DAILY_API_KEY")

pytestmark = [
    pytest.mark.skipif(
        not DAILY_API_KEY,
        reason="no Daily account: set TEST_DAILY_API_KEY to join a real Daily room",
    ),
    pytest.mark.timeout(120),
]

SETTINGS = StartSettings.from_connection(
    "daily_room.pipecat_cloud",
    {"agentName": "live-daily-probe"},
    {"publicApiKey": "pk_live0daily0probe0not0used"},
)


def _daily(method: str, path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"https://api.daily.co/v1{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {DAILY_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as answer:
        return json.loads(answer.read() or b"{}")


@pytest.fixture
def room_url() -> Iterator[str]:
    room = _daily(
        "POST",
        "/rooms",
        {"properties": {"exp": int(time.time()) + 300, "eject_at_room_exp": True}},
    )
    try:
        yield room["url"]
    finally:
        _daily("DELETE", f"/rooms/{room['name']}")


class ScriptedBot:
    """A daily-python participant that speaks a tone and answers RTVI."""

    def __init__(self, room_url: str, *, answer: str) -> None:
        from daily import CallClient, CustomAudioSource, CustomAudioTrack, EventHandler

        from egma_simulator.media.daily_room import _initialize_daily

        _initialize_daily()
        self.answer = answer
        self.heard: list[dict[str, Any]] = []
        self._stop = threading.Event()
        bot = self

        class Events(EventHandler):
            def on_app_message(self, message: Any, sender: str) -> None:
                if isinstance(message, dict):
                    bot.heard.append(message)
                    threading.Thread(
                        target=bot._reply, args=(message, sender), daemon=True
                    ).start()

        self.client = CallClient(event_handler=Events())
        self.source = CustomAudioSource(16000, 1, True)
        self.track = CustomAudioTrack(self.source)
        joined = threading.Event()
        self.client.join(
            room_url,
            client_settings={
                "inputs": {
                    "camera": False,
                    "microphone": {
                        "isEnabled": True,
                        "settings": {"customTrack": {"id": self.track.id}},
                    },
                },
                "publishing": {"microphone": {"isPublishing": True}},
            },
            completion=lambda *_args: joined.set(),
        )
        assert joined.wait(20), "the scripted bot could not join"
        self.id = self.client.participants()["local"]["id"]
        self._feeder = threading.Thread(target=self._feed, daemon=True)
        self._feeder.start()

    def _feed(self) -> None:
        frame = b"".join(
            struct.pack("<h", int(6000 * math.sin(2 * math.pi * 440 * i / 16000)))
            for i in range(320)
        )
        while not self._stop.is_set():
            self.source.write_frames(frame)
            time.sleep(0.02)

    def _say(self, kind: str, **data: Any) -> None:
        message: dict[str, Any] = {"label": "rtvi-ai", "type": kind}
        if data:
            message["data"] = data
        self.client.send_app_message(message)

    def _reply(self, message: dict[str, Any], _sender: str) -> None:
        kind = message.get("type")
        if kind == "client-ready":
            self._say("bot-ready", version="2.1.0")
        elif kind == "send-text":
            self._say("bot-interrupted")
            self._say("bot-llm-started")
            for word in self.answer.split(" "):
                self._say("bot-llm-text", text=f"{word} ")
                time.sleep(0.02)
            self._say("bot-llm-stopped")

    def leave(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        left = threading.Event()
        self.client.leave(completion=lambda *_args: left.set())
        left.wait(10)
        self.client.release()


@pytest.fixture
async def bot(room_url: str) -> AsyncIterator[ScriptedBot]:
    scripted = await asyncio.to_thread(
        ScriptedBot, room_url, answer="We open at nine on Saturday."
    )
    try:
        yield scripted
    finally:
        await asyncio.to_thread(scripted.leave)


def _backend(kind: Any, room_url: str) -> Any:
    async def accepted() -> AgentReport:
        return AgentReport(state="accepted")

    backend = kind(
        settings=SETTINGS,
        simulation_id="sim_live_daily_probe",
        max_duration_seconds=120,
        agent_report=accepted,
    )

    async def start(*, deadline: float) -> DailyWayIn:
        del deadline
        return DailyWayIn(room_url=room_url)

    backend.starter.start = start
    return backend


async def test_a_chat_simulation_types_to_a_bot_in_a_real_daily_room(
    room_url: str, bot: ScriptedBot
):
    backend = _backend(PipecatChatBackend, room_url)
    try:
        await backend.open_room()
        assert await backend.wait_started() == "sim_live_daily_probe"
        answer = await backend.deliver(
            "When are you open on Saturday?", reply_seconds=10
        )
    finally:
        await backend.teardown()

    assert answer.text == "We open at nine on Saturday."
    kinds = [message.get("type") for message in bot.heard]
    assert kinds.count("client-ready") == 1
    assert "send-text" in kinds
    sent = next(message for message in bot.heard if message["type"] == "send-text")
    assert sent["data"]["options"] == {
        "run_immediately": True,
        "audio_response": False,
    }


async def test_a_voice_simulation_hears_a_bot_in_a_real_daily_room(
    room_url: str, bot: ScriptedBot
):
    from pipecat.frames.frames import Frame, InputAudioRawFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import WorkerRunner
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    heard: list[str] = []

    class Ear(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, InputAudioRawFrame):
                heard.append(getattr(frame, "user_id", ""))
            if isinstance(frame, RemoteParticipantLeftFrame):
                frame.completed.set()
            await self.push_frame(frame, direction)

    backend = _backend(PipecatVoiceBackend, room_url)
    media = await backend.create_transport()
    worker = PipelineWorker(
        Pipeline([*media.input, Ear(), *media.output]),
        params=PipelineParams(),
        idle_timeout_secs=None,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.ensure_future(runner.run())
    try:
        await backend.dial()
        assert await backend.wait_started() == "sim_live_daily_probe"
        await asyncio.sleep(1.0)
        assert bot.id in heard, "the bot's audio reached the persona's pipeline"
        assert [m.get("type") for m in bot.heard].count("client-ready") == 1
        await asyncio.to_thread(bot.leave)
        await asyncio.wait_for(media.ended.wait(), 15)
        assert not media.failed.is_set()
    finally:
        from pipecat.frames.frames import EndFrame

        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 15)
        await backend.teardown()
