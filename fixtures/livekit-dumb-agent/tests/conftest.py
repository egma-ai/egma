"""Load the fixture agent and provide offline job contexts for its integration tests."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from egma import export
from livekit.agents import Agent, AgentSession, ToolContext
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

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
    """Provide an Egma participant with valid RPC replies in a production room.
    The SDK must still send nothing; assert asked is empty so inertness is
    proved by room detection, not by participant absence or RPC failure.
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
    """A job context, down to the three things the SDK reads of one."""

    room: StubRoom
    job: StubJob
    shutdown_callbacks: list[Any] = field(default_factory=list)

    async def connect(self) -> None:
        self.room.connect_calls += 1

    def add_shutdown_callback(self, callback: Any) -> None:
        """Where the span export puts its last flush before the job exits."""
        self.shutdown_callbacks.append(callback)


def outside_egma(
    room_name: str = "maple-street-front-desk", metadata: str = ""
) -> StubContext:
    """A job in anybody's room but egma's, which is every production one."""
    return StubContext(
        room=StubRoom(),
        job=StubJob(room=StubJobRoom(name=room_name), metadata=metadata),
    )


def inside_egma(
    room_name: str = "egma-sim-fixture-0001", metadata: str = ""
) -> StubContext:
    """Simulation job with an initially empty room. arrive() can add Egma later.
    metadata contains the serialized test-owned dispatch context.
    """
    return StubContext(
        room=StubRoom(present=()),
        job=StubJob(room=StubJobRoom(name=room_name), metadata=metadata),
    )


PROJECT_KEY = f"egma_sk_{'a' * 43}"
"""A key shaped exactly like a real project key and belonging to nobody."""


@pytest.fixture
def egma_export(monkeypatch):
    """Somewhere for a simulation's spans to go, in memory.

    ``egma.simulation`` installs the export before it says anything, and a
    simulation room with nowhere to report is one the SDK refuses — which
    is the point of the SDK and not a thing this suite is proving. So the
    exporter is arranged, and what these tests look at is the exchange.
    """
    provider = TracerProvider()
    monkeypatch.setattr(
        export, "_select_compatible_provider", lambda _verb, _reference: provider
    )
    monkeypatch.setattr(
        export, "_register_provider", lambda _provider, _reference: None
    )
    monkeypatch.setattr(
        export,
        "_build_exporter",
        lambda _endpoint, _key, _verb: InMemorySpanExporter(),
    )
    monkeypatch.setattr(export, "_state", None)
    monkeypatch.setenv("EGMA_URL", "https://api.egma.ai")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    yield provider
    provider.shutdown()


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
