"""A daily_room voice spec conducts a whole simulation through the voice conductor.

The golden Pipecat Cloud voice fixture is assembled by the real pipeline; the
Daily room is replaced by the scripted Pipecat transport CI uses elsewhere, and
the start request and agent report are doubles.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.contract import contract_dir
from egma_simulator.conversation import ConversationControls
from egma_simulator.media import VoiceMedia
from egma_simulator.media import daily_room as daily
from egma_simulator.media.daily_room import (
    AgentReport,
    DailyWayIn,
    PipecatVoiceBackend,
    RoomEvents,
)
from egma_simulator.media.scripted_transport import ScriptedTransport
from egma_simulator.model import ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import PlugError
from egma_simulator.plugs import daily_room as daily_plug
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR

BOT_ID = "bot-participant-0001"
FLOWS_REFUSAL = (
    'the test mocks "route_to_billing", and this is a Pipecat Flows function; '
    "Egma cannot mock it yet. Remove it from the test's mock tools. Flows "
    "functions that are not mocked run for real and are recorded."
)


class ScriptedDailyRoom:
    """A Daily room whose bot is the scripted Pipecat transport."""

    def __init__(self, *, events: RoomEvents, transport: ScriptedTransport) -> None:
        self.events = events
        self.transport = transport
        media = transport.media
        self.ended = media.ended
        self.failed = media.failed
        self.fault: str | None = None
        self._media = replace(media, fault=lambda: self.fault)
        self.sent: list[dict[str, Any]] = []
        self._activation: asyncio.Task[None] | None = None

    def create_transport(self, *, audio_out_mixer: object = None) -> VoiceMedia:
        del audio_out_mixer
        return self._media

    async def wait_joined(self, within: float) -> None:
        del within
        self.events.joined({"participants": {"local": {"id": "persona"}}})
        self.events.participant(
            {"id": BOT_ID, "media": {"microphone": {"state": "playable"}}}
        )
        self._activation = asyncio.ensure_future(self.transport.activate())

    async def send(self, message: Mapping[str, Any]) -> None:
        self.sent.append(dict(message))

    async def bot_departed(self) -> None:
        return None

    async def leave(self) -> None:
        self.transport.stop()
        if self._activation is not None and not self._activation.done():
            self._activation.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._activation


def rig(
    monkeypatch: pytest.MonkeyPatch,
    *,
    report: Callable[[], Awaitable[AgentReport]],
    greeting: str | None = "Lakeside Dental, how can I help?",
    replies: list[str] | None = None,
) -> list[ScriptedDailyRoom]:
    rooms: list[ScriptedDailyRoom] = []

    class Scripted(PipecatVoiceBackend):
        def __init__(self, **arguments: Any) -> None:
            arguments["agent_report"] = report
            super().__init__(**arguments)

            async def start(*, deadline: float) -> DailyWayIn:
                del deadline
                return DailyWayIn(room_url="https://lakeside.daily.co/r")

            self.starter.start = start

        def _joined_room(self, way_in: DailyWayIn) -> ScriptedDailyRoom:
            del way_in
            room = ScriptedDailyRoom(
                events=self._room_events(),
                transport=ScriptedTransport(
                    greeting=greeting,
                    replies=replies or ["We have Tuesday at ten."],
                    answer_delay_seconds=0.05,
                    ends_after_replies=False,
                ),
            )
            rooms.append(room)
            return room

    monkeypatch.setattr(daily_plug, "PipecatVoiceBackend", Scripted)
    return rooms


def voice_spec(max_duration_seconds: int = 60) -> SimulationSpec:
    document = json.loads(
        (
            contract_dir() / "fixtures/spec/valid/voice-pipecat-cloud.json"
        ).read_text(encoding="utf-8")
    )
    document["scenario"]["instructions"] = (
        "Ask for a cleaning appointment. Take the offered time."
    )
    document["limits"] = {"max_duration_seconds": max_duration_seconds, "max_turns": 6}
    return SimulationSpec.from_document(document)


async def conduct(
    spec: SimulationSpec,
    tmp_path: Path,
    turns: list[tuple[str, str]] | None = None,
) -> tuple[Any, list]:
    registered: list[str] = []

    async def register(reference: str) -> None:
        registered.append(reference)

    turns = [] if turns is None else turns

    async def on_utterance(speaker: str, text: str, _began: int, _ended: int) -> None:
        turns.append((speaker, text))

    async def on_measured(*_facts: object) -> None:
        return None

    assembled = assemble(
        spec,
        blobs=FilesystemBlobStore(tmp_path),
        speech=SCRIPTED_PAIR,
        on_provider_reference=register,
    )
    assert assembled.conductor is not None
    conducted = await assembled.conductor.conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=ConversationControls(),
        name="sim:daily-room-test",
        on_utterance=on_utterance,
        on_measured=on_measured,
    )
    assert registered == [spec.simulation_id]
    return conducted, turns


async def accepted() -> AgentReport:
    return AgentReport(state="accepted")


async def test_a_pipecat_voice_spec_conducts_a_whole_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    rooms = rig(monkeypatch, report=accepted)
    spec = voice_spec()
    conducted, turns = await conduct(spec, tmp_path)

    assert conducted.status == "completed"
    assert conducted.provider_reference == spec.simulation_id
    assert turns[0] == ("agent", "Lakeside Dental, how can I help?")
    assert any(speaker == "human" for speaker, _text in turns)
    (room,) = rooms
    assert [message["type"] for message in room.sent].count("client-ready") == 1


async def test_a_refused_report_mid_call_fails_in_the_servers_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(daily, "AGENT_REPORT_WATCH_SECONDS", 0.05)
    asked = 0

    async def refused_later() -> AgentReport:
        nonlocal asked
        asked += 1
        if asked < 4:
            return AgentReport(state="accepted")
        return AgentReport(state="refused", code=905, message=FLOWS_REFUSAL)

    rig(
        monkeypatch,
        report=refused_later,
        replies=["Let me check.", "Still checking.", "One moment."],
    )
    heard: list[tuple[str, str]] = []
    with pytest.raises(PlugError) as refused:
        await conduct(voice_spec(), tmp_path, heard)
    assert str(refused.value) == FLOWS_REFUSAL
    assert heard, "the refusal arrived after the conversation had started"


async def test_a_bot_that_never_reports_fails_its_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(daily, "PIPECAT_STARTUP_SECONDS", 0.3)
    monkeypatch.setattr(daily, "AGENT_REPORT_POLL_SECONDS", 0.02)

    async def waiting() -> AgentReport:
        return AgentReport(state="waiting")

    rig(monkeypatch, report=waiting)
    with pytest.raises(PlugError) as refused:
        await conduct(voice_spec(), tmp_path)
    assert str(refused.value).startswith(
        "your bot joined but did not report to Egma within"
    )
    assert refused.value.ending == "error"
