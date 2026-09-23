"""Opt-in: the Daily lane against a real Pipecat Cloud agent.

Run: uv run pytest tests/test_live_pipecat_cloud.py -v
Set TEST_PIPECAT_PUBLIC_KEY (or EGMA_PIPECAT_PUBLIC_KEY) and
TEST_PIPECAT_AGENT_NAME: a deployed agent shaped like Pipecat's quickstart
(RTVI on, greeting on client-ready, a tool it can call). TEST_PIPECAT_CHAT_BODY
and TEST_PIPECAT_VOICE_BODY are optional JSON merged into each test's start
request body. TEST_PIPECAT_CHAT_TURN is an optional persona line for chat.

The start request, the Daily join, RTVI and the turn logic are production code
against the real service. The agent report is a double answering accepted,
because a deployed bot reports to an Egma server this test does not run.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import pytest
from conftest import credential

from egma_simulator.media import RemoteParticipantLeftFrame
from egma_simulator.media.daily_room import (
    AgentReport,
    PipecatChatBackend,
    PipecatVoiceBackend,
    StartSettings,
)

PUBLIC_KEY = credential("TEST_PIPECAT_PUBLIC_KEY", "EGMA_PIPECAT_PUBLIC_KEY")
AGENT_NAME = credential("TEST_PIPECAT_AGENT_NAME")
CHAT_BODY = json.loads(os.environ.get("TEST_PIPECAT_CHAT_BODY") or "{}")
VOICE_BODY = json.loads(os.environ.get("TEST_PIPECAT_VOICE_BODY") or "{}")
CHAT_TURN = os.environ.get("TEST_PIPECAT_CHAT_TURN") or "What are your hours?"

pytestmark = [
    pytest.mark.skipif(
        not (PUBLIC_KEY and AGENT_NAME),
        reason=(
            "no Pipecat Cloud agent: set TEST_PIPECAT_PUBLIC_KEY and "
            "TEST_PIPECAT_AGENT_NAME to start a real bot"
        ),
    ),
    pytest.mark.timeout(240),
]


def _backend(kind: Any, body_params: dict[str, Any]) -> Any:
    async def accepted() -> AgentReport:
        return AgentReport(state="accepted")

    return kind(
        settings=StartSettings.from_connection(
            "daily_room.pipecat_cloud",
            {"agentName": AGENT_NAME},
            {"publicApiKey": PUBLIC_KEY},
        ),
        simulation_id="sim_live_pipecat_cloud",
        max_duration_seconds=180,
        body_params=body_params,
        agent_report=accepted,
    )


async def test_a_chat_simulation_starts_and_types_to_a_pipecat_cloud_bot():
    backend = _backend(PipecatChatBackend, CHAT_BODY)
    try:
        await backend.open_room()
        assert backend.room._way_in.token, "Pipecat Cloud answered a dailyToken"
        await backend.wait_started()
        greeting = await backend.wait_greeting(15)
        answer = await backend.deliver(CHAT_TURN, reply_seconds=30)
    finally:
        await backend.teardown()

    print(f"greeting: {greeting.text!r}")
    print(f"answer: {answer.text!r}")
    assert answer.text, "the bot answered the typed turn in RTVI text"
    assert not answer.ended


async def test_a_voice_simulation_hears_a_pipecat_cloud_bot_greet():
    from pipecat.frames.frames import EndFrame, Frame, InputAudioRawFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import WorkerRunner
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    loud: list[int] = []

    class Ear(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, InputAudioRawFrame) and any(frame.audio[1::64]):
                loud.append(len(frame.audio))
            if isinstance(frame, RemoteParticipantLeftFrame):
                frame.completed.set()
            await self.push_frame(frame, direction)

    backend = _backend(PipecatVoiceBackend, VOICE_BODY)
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
        await backend.wait_started()
        await asyncio.sleep(8)
    finally:
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 20)
        await backend.teardown()

    assert loud, "the bot's greeting reached the persona's pipeline as sound"
