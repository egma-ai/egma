"""An offline Daily room and a scripted Pipecat bot behind the real lifecycle.

The backends run production code for the start, readiness, RTVI and turn logic;
only the room and the start request are replaced. ``FakeBot`` answers RTVI
messages the way a Pipecat 1.9 bot does, with event order taken from a live
trace (a tool call's ``llm-function-call-started`` arrives before the
``bot-llm-stopped`` of the run that asked for it, and its id arrives after).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from egma_simulator.media import MediaBackendError, VoiceMedia
from egma_simulator.media.daily_room import (
    AgentReport,
    DailyWayIn,
    PipecatChatBackend,
    PipecatVoiceBackend,
    RoomEvents,
    StartSettings,
)

BOT_ID = "bot-participant-0001"
PERSONA_ID = "persona-participant-0001"
A_ROOM = "https://lakeside.daily.co/egma-room-0001"


def rtvi(kind: str, **data: Any) -> dict[str, Any]:
    message: dict[str, Any] = {"label": "rtvi-ai", "type": kind}
    if data:
        message["data"] = data
    return message


@dataclass
class Step:
    """One bot message, sent ``after`` seconds after the previous one."""

    message: dict[str, Any]
    after: float = 0.0


def answer(text: str) -> list[Step]:
    """One plain model run."""
    return [
        Step(rtvi("bot-llm-started")),
        *[Step(rtvi("bot-llm-text", text=word)) for word in _words(text)],
        Step(rtvi("bot-llm-stopped")),
    ]


def answer_through_a_tool(
    filler: str, final: str, *, tool_seconds: float, call_id: str = "call_1"
) -> list[Step]:
    """A filler, a tool call, and the answer out of it, in live order."""
    return [
        Step(rtvi("bot-llm-started")),
        *[Step(rtvi("bot-llm-text", text=word)) for word in _words(filler)],
        Step(rtvi("llm-function-call-started")),
        Step(rtvi("bot-llm-stopped")),
        Step(rtvi("llm-function-call-in-progress", tool_call_id=call_id)),
        Step(
            rtvi("llm-function-call-stopped", tool_call_id=call_id, cancelled=False),
            after=tool_seconds,
        ),
        *answer(final),
    ]


def _words(text: str) -> list[str]:
    words = text.split(" ")
    return [word if index == 0 else f" {word}" for index, word in enumerate(words)]


@dataclass
class FakeBot:
    """A scripted Pipecat bot behind RTVI."""

    rtvi_on: bool = True
    greeting: list[Step] = field(default_factory=list)
    replies: list[list[Step]] = field(default_factory=list)
    refuse_send_text: str | None = None
    heard: list[dict[str, Any]] = field(default_factory=list)

    async def on_message(self, room: FakeRoom, message: Mapping[str, Any]) -> None:
        self.heard.append(dict(message))
        if not self.rtvi_on or not room.bot_present:
            return
        kind = message.get("type")
        if kind == "client-ready":
            ready = rtvi("bot-ready", version="2.1.0")
            ready["id"] = message.get("id")
            room.bot_says(ready)
            if self.greeting:
                room.play(self.greeting)
        elif kind == "send-text":
            if self.refuse_send_text is not None:
                refusal = rtvi("error-response", error=self.refuse_send_text)
                refusal["id"] = message.get("id")
                room.bot_says(refusal)
                return
            room.bot_says(rtvi("bot-interrupted"))
            if self.replies:
                room.play(self.replies.pop(0))


class FakeRoom:
    """Both room shapes: voice's transport room and chat's call client."""

    def __init__(
        self,
        *,
        way_in: DailyWayIn,
        events: RoomEvents,
        quotable: Callable[[str], str],
        bot: FakeBot,
        bot_here_at_join: bool,
        bot_audio: bool,
        bot_seen_before_join: bool = False,
    ) -> None:
        del quotable
        self.bot_seen_before_join = bot_seen_before_join
        self.way_in = way_in
        self.events = events
        self.bot = bot
        self.bot_here_at_join = bot_here_at_join
        self.bot_audio = bot_audio
        self.bot_present = False
        self.sent: list[dict[str, Any]] = []
        self.refused_before_join: list[dict[str, Any]] = []
        self.joined = False
        self.left = False
        self.departures = 0
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self.fault: str | None = None
        self._playing: set[asyncio.Task[None]] = set()

    # Voice.
    def create_transport(self, *, audio_out_mixer: object = None) -> VoiceMedia:
        del audio_out_mixer
        return VoiceMedia(
            input=(),
            output=(),
            ended=self.ended,
            failed=self.failed,
            fault=lambda: self.fault,
        )

    async def wait_joined(self, within: float) -> None:
        del within
        self._join()

    async def bot_departed(self) -> None:
        self.departures += 1
        self.ended.set()

    # Chat.
    async def join(self, within: float) -> None:
        del within
        if self.bot_seen_before_join:
            # daily-python can report a present participant before the join's
            # own completion arrives.
            self.bot_joins()
            await asyncio.sleep(0.05)
        self._join()

    # Both.
    async def send(self, message: Mapping[str, Any]) -> None:
        if not self.joined:
            self.refused_before_join.append(dict(message))
            raise MediaBackendError("the call client has not joined yet")
        self.sent.append(dict(message))
        await self.bot.on_message(self, message)

    async def leave(self) -> None:
        self.left = True
        for task in self._playing:
            task.cancel()
        self.ended.set()

    # What tests make the bot do.
    def _join(self) -> None:
        self.joined = True
        self.events.joined({"participants": {"local": {"id": PERSONA_ID}}})
        if self.bot_here_at_join and not self.bot_present:
            self.bot_joins()

    def bot_joins(self) -> None:
        self.bot_present = True
        self.events.participant(
            {
                "id": BOT_ID,
                "info": {"isLocal": False, "userName": "Pipecat"},
                "media": {
                    "microphone": {"state": "playable" if self.bot_audio else "off"}
                },
            }
        )

    def bot_publishes_audio(self) -> None:
        self.bot_audio = True
        self.events.participant(
            {"id": BOT_ID, "media": {"microphone": {"state": "playable"}}}
        )

    def bot_says(self, message: dict[str, Any]) -> None:
        self.events.message(message, BOT_ID)

    async def bot_leaves(self) -> None:
        self.bot_present = False
        await self.events.left(BOT_ID)

    def play(self, steps: list[Step]) -> None:
        async def run() -> None:
            for step in steps:
                if step.after:
                    await asyncio.sleep(step.after)
                else:
                    await asyncio.sleep(0)
                self.bot_says(step.message)

        task = asyncio.ensure_future(run())
        self._playing.add(task)
        task.add_done_callback(self._playing.discard)


@dataclass
class Rig:
    """One backend and everything a test reads back from it."""

    backend: Any
    bot: FakeBot
    order: list[str]
    reports: list[AgentReport]
    probes: int = 0
    rooms: list[FakeRoom] = field(default_factory=list)

    @property
    def room(self) -> FakeRoom:
        """The room the backend joined, kept after teardown."""
        assert self.rooms, "the backend has not joined a room"
        return self.rooms[-1]


def rigged(
    kind: type[PipecatVoiceBackend] | type[PipecatChatBackend],
    *,
    settings: StartSettings,
    bot: FakeBot | None = None,
    bot_here_at_join: bool = True,
    bot_audio: bool = True,
    bot_seen_before_join: bool = False,
    reports: list[AgentReport] | None = None,
    start_delay: float = 0.0,
    start: Callable[[], Awaitable[DailyWayIn]] | None = None,
) -> Rig:
    """A backend whose starter answers A_ROOM and whose room is a FakeRoom."""
    bot = bot or FakeBot()
    order: list[str] = []
    answered = list(reports or [AgentReport(state="accepted")])
    rig_holder: dict[str, Rig] = {}

    async def register(reference: str) -> None:
        order.append(f"register:{reference}")

    async def report() -> AgentReport:
        rig_holder["rig"].probes += 1
        return answered.pop(0) if len(answered) > 1 else answered[0]

    class Rigged(kind):  # type: ignore[valid-type, misc]
        def _joined_room(self, way_in: DailyWayIn) -> FakeRoom:
            room = FakeRoom(
                way_in=way_in,
                events=self._room_events(),
                quotable=self._quotable,
                bot=bot,
                bot_here_at_join=bot_here_at_join,
                bot_audio=bot_audio,
                bot_seen_before_join=bot_seen_before_join,
            )
            rig_holder["rig"].rooms.append(room)
            return room

    backend = Rigged(
        settings=settings,
        simulation_id="sim_01K5TB2H8Y4P7QCWF9XKMD6RZP",
        max_duration_seconds=600,
        on_provider_reference=register,
        agent_report=report,
    )

    async def fake_start(*, deadline: float) -> DailyWayIn:
        del deadline
        order.append("start")
        if start is not None:
            return await start()
        if start_delay:
            await asyncio.sleep(start_delay)
        return DailyWayIn(room_url=A_ROOM, token="a-daily-token")

    backend.starter.start = fake_start
    rig = Rig(backend=backend, bot=bot, order=order, reports=answered)
    rig_holder["rig"] = rig
    return rig
