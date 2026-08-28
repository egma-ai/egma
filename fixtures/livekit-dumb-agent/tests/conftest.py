"""What the fixture's own tests build from.

Two things and no more: a way to reach ``agent.py``, which sits beside
this directory rather than inside an importable package, and the two
stand-ins a job context is when nothing is really running.

Nothing here talks to LiveKit, to OpenAI, or to a room. That is the point
of the suite: what it proves is what this agent does when there is no
egma anywhere near it, and a test that needed a server could not prove
that on the developer's machine.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from livekit.agents import Agent, AgentSession, ToolContext

# The agent is a script, not a package: it is run as ``uv run agent.py``,
# which is how a customer's own worker is run. Reaching it by path keeps
# the file being tested the very file being run.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@dataclass
class StubJobRoom:
    """The room as the server described it to the worker."""

    name: str


@dataclass
class StubJob:
    """A job, down to the two fields the SDK reads of one."""

    room: StubJobRoom
    metadata: str


@dataclass
class StubEgmaParticipant:
    """Somebody in the room by egma's own name, who nothing should ask."""

    identity: str = "egma-persona"


@dataclass
class StubRoom:
    """A room with a willing egma in it, which nothing should ever ask.

    Every message the SDK could send goes through ``perform_rpc``, and
    this one **answers** rather than refusing — with a well-formed reply
    naming a tool it would cover. That is deliberate: a room that failed
    the call would fail the test at the call, which proves the same thing
    twice and hides which claim broke. Answering means an SDK that spoke
    in a production room goes on to succeed, quietly, and is caught by
    the one thing that would then be untrue — ``asked`` not being empty.

    egma is in the participant list for the same reason. The SDK finds
    egma by name among the people in the room, so a room with nobody in it
    would make this suite pass by absence rather than by the room's name
    being the customer's own.
    """

    asked: list[str] = field(default_factory=list)
    connect_calls: int = 0
    present: tuple[str, ...] = ("egma-persona",)

    def __post_init__(self) -> None:
        self.remote_participants = {
            identity: StubEgmaParticipant(identity) for identity in self.present
        }
        self._listeners: list[Any] = []

    @property
    def local_participant(self) -> StubRoom:
        return self

    def isconnected(self) -> bool:
        return True

    def on(self, event: str, callback: Any) -> Any:
        if event == "participant_connected":
            self._listeners.append(callback)
        return callback

    def off(self, event: str, callback: Any) -> None:
        if callback in self._listeners:
            self._listeners.remove(callback)

    def arrive(self, identity: str) -> None:
        """Put somebody in the room the way LiveKit announces one."""
        participant = StubEgmaParticipant(identity)
        self.remote_participants[identity] = participant
        for callback in list(self._listeners):
            callback(participant)

    async def perform_rpc(self, *, method: str, **_rest: Any) -> str:
        self.asked.append(method)
        return json.dumps(
            {"protocol_version": 1, "mocked_tools": ["check_availability"]}
        )


@dataclass
class StubContext:
    """A job context, down to the two things the SDK reads of one."""

    room: StubRoom
    job: StubJob

    async def connect(self) -> None:
        self.room.connect_calls += 1


def outside_egma(
    room_name: str = "maple-street-front-desk", metadata: str = ""
) -> StubContext:
    """A job in anybody's room but egma's, which is every production one."""
    return StubContext(
        room=StubRoom(),
        job=StubJob(room=StubJobRoom(name=room_name), metadata=metadata),
    )


def inside_egma(room_name: str = "egma-sim-fixture-0001") -> StubContext:
    """A job in a room egma named, with nobody in it yet.

    Empty on purpose. Nothing dispatches this worker on egma's behalf
    unless the practice configured a named agent, so the ordinary order is
    that this agent is in the room first and egma walks in afterwards —
    which is what ``StubRoom.arrive`` is for.
    """
    return StubContext(
        room=StubRoom(present=()),
        job=StubJob(room=StubJobRoom(name=room_name), metadata=""),
    )


@pytest.fixture
async def session() -> AgentSession:
    """A session object, never started.

    What the SDK does with a session is use it as the identity a
    substitution is filed under; starting one would need a model, a
    microphone and a room. Built inside the loop because a session reaches
    for the running one as it is created.
    """
    return AgentSession()


def tools_on(agent: Agent) -> dict[str, Any]:
    """The agent's tools by name, read the way the SDK reads them."""
    return dict(ToolContext(agent.tools).function_tools)
