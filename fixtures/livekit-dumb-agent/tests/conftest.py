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
class StubJob:
    """A job, down to the one field the SDK reads of one."""

    metadata: str


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
    """

    asked: list[str] = field(default_factory=list)

    @property
    def local_participant(self) -> StubRoom:
        return self

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


def outside_egma(metadata: str = "") -> StubContext:
    """A job dispatched by anybody but egma, which is every production one."""
    return StubContext(room=StubRoom(), job=StubJob(metadata=metadata))


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
