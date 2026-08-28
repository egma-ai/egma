"""What every test here builds from, and the one place LiveKit's own
internals are read.

The agents below are real :class:`~livekit.agents.Agent` subclasses with
real ``@function_tool`` methods, because the SDK reads its census off a
real agent object and a hand-rolled shape would prove the shape rather
than the reading.

## Reading the side table on purpose

``mock_tools`` writes into a table LiveKit keeps privately, and the same
table is what the framework's tool dispatch consults per call. So the
only way to say "a courier is standing in front of exactly these names,
and it answers a call the way the framework would deliver one" without a
LiveKit server is to read that table and call through the framework's own
argument trimming.

Both are private names, and reaching for them is deliberate. This package
pins ``livekit-agents`` to one minor precisely because the substitution
mechanism carries no stability promise — and a failing import here is
that pin's tripwire firing, at test time, on the developer's machine,
which is exactly where it should fire.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from livekit.agents import Agent, AgentSession, function_tool

# LiveKit's own, read on purpose: see the module docstring.
from livekit.agents.voice.run_result import (  # noqa: PLC2701
    _run_mock,
    _SessionMockTools,
)
from room_stub import SIMULATION_ROOM, StubContext, StubRoom


class ReceptionAgent(Agent):
    """A small agent with two tools: one egma will answer for, one it
    will not, so every test can say what happened to each."""

    def __init__(self) -> None:
        super().__init__(instructions="You are a dental receptionist.")

    @function_tool
    async def check_calendar(self, day: str, party_size: int = 1) -> str:
        """Look up free slots on a day.

        Args:
            day: The day to look at.
            party_size: How many people are coming.
        """
        return f"really ran: {day} for {party_size}"

    @function_tool
    async def read_notice(self) -> str:
        """Read the practice's notice of the day."""
        return "really ran: the notice"


class ToollessAgent(Agent):
    """An agent with nothing to mock, for the census that reports none."""

    def __init__(self) -> None:
        super().__init__(instructions="You answer the phone and nothing else.")


@pytest.fixture
async def session() -> AgentSession:
    """A session object, which is the key the side table is written under.

    Never started: what the SDK does with a session is hand it to
    ``mock_tools`` as an identity, and starting one would need a model,
    a microphone and a room. Built inside the loop because a session
    reaches for the running one as it is created.
    """
    return AgentSession()


def in_a_simulation(
    room: StubRoom, room_name: str = SIMULATION_ROOM, metadata: str = ""
) -> StubContext:
    """A job whose room egma named for a simulation.

    The metadata is empty by default, and that is the point of the
    default: an egma that names itself nowhere but in the room's name is
    the ordinary case, and every test that does not say otherwise is
    written against it.
    """
    return StubContext(room, room_name, metadata)


def couriers_on(session: AgentSession, agent: Agent) -> dict[str, Any]:
    """What is standing in front of this agent's tools, by name.

    Read straight off LiveKit's own side table — the very table its tool
    dispatch consults — so "registered" here means registered where it
    counts, not where the SDK says it put something.
    """
    return dict(_SessionMockTools.get(session, {}).get(type(agent), {}))


async def called(courier: Any, *args: Any, **kwargs: Any) -> Any:
    """Call a courier the way the framework delivers a call to one.

    Through LiveKit's own trimming, which is the thing that hands a mock
    only the parameters it declares — and therefore the thing that makes
    the copied signature matter at all. A test that called the courier
    directly would pass whatever it liked and prove nothing about it.
    """
    return await _run_mock(courier, *args, **kwargs)


# -- A real LiveKit, for the suites that will not take a stub ----------------
#
# Everything above proves the SDK against a room-shaped fake, which is the
# right default: it needs no server, no account and no network, so it runs
# on every machine and in CI. What it cannot say is whether egma is really
# found in a real room's participant table, or whether the wait that makes
# three of the four dispatch paths work really ends when a real participant
# really arrives. Those are the two claims the room-name contract rests on,
# and a fake that answers them is answering for itself.
#
# So there is a second lane, and its point is that it costs no account: the
# server is the one this repository already deploys, started in its own dev
# mode, and the conversation is never held — no speech, no model, no keys.
# What it exercises is detection, addressing and the exchange, which is all
# of the SDK that a real LiveKit can contradict.


LIVEKIT_HEALTH_SECONDS = 30.0
"""How long a freshly started server has to answer before it counts as
one that will not start."""

LIVEKIT_DEV_KEY = "devkey"
LIVEKIT_DEV_SECRET = "secret"
"""The pair ``livekit-server --dev`` prints and uses. Publicly known, and
correctly so: it opens a server bound to this machine for the length of one
test run, and nothing else. A deployment that used it would be a mistake
this fixture cannot make, because it starts its own server rather than
reaching one."""


def _first_set(*names: str) -> str:
    """The first of these environment variables that carries a value.

    A ``TEST_``-prefixed name is read before the provider's own plain one,
    so a machine can keep the coordinates it tests against apart from the
    ones it works with. The simulator's suite reads its credentials the
    same way, and the two are deliberately separate: these packages ship
    as separate wheels and share no test code.
    """
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


@dataclass(frozen=True)
class LiveKit:
    """Where a real LiveKit is, and what opens it."""

    url: str
    api_key: str
    api_secret: str

    def token(self, room: str, identity: str) -> str:
        """A join token for one room and one identity, and nothing else."""
        from livekit import api

        return (
            api.AccessToken(self.api_key, self.api_secret)
            .with_identity(identity)
            .with_name(identity)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )


def _pinned_livekit_image() -> str:
    """The server tag this repository deploys, read off the compose file.

    Read rather than repeated, for the reason CI reads its own object-store
    tag the same way: a second copy of a version is a second thing to
    forget, and the one that rots is always the one nobody runs.
    """
    compose = Path(__file__).resolve().parents[3] / "docker-compose.yml"
    try:
        lines = compose.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    inside = False
    for line in lines:
        if line.startswith("  livekit:"):
            inside = True
        elif inside and line.strip().startswith("image:"):
            return line.split("image:", 1)[1].strip()
        elif inside and line and not line.startswith("    "):
            break
    return ""


def _answering(url: str) -> bool:
    """Whether something is already serving on that address."""
    probe = url.replace("ws://", "http://").replace("wss://", "https://")
    try:
        with urllib.request.urlopen(probe, timeout=1):
            return True
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False


@pytest.fixture(scope="session")
def live_livekit() -> Iterator[LiveKit]:
    """A real LiveKit for one test session: the one named, or one started.

    Two ways in, and a test cannot tell them apart. A machine that already
    has a project says so through the environment and this reaches it. A
    machine that says nothing gets the server this repository deploys,
    started in dev mode on loopback and stopped again at the end.

    It skips rather than fails where neither is possible, because a
    developer without Docker is not a developer with a broken SDK.
    """
    named = _first_set("TEST_LIVEKIT_URL", "LIVEKIT_URL")
    if named:
        key = _first_set("TEST_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
        secret = _first_set("TEST_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
        if not key or not secret:
            pytest.skip(
                "TEST_LIVEKIT_URL names a server but its key pair is not set: "
                "set TEST_LIVEKIT_API_KEY and TEST_LIVEKIT_API_SECRET too"
            )
        yield LiveKit(named, key, secret)
        return

    image = _pinned_livekit_image()
    if not image:
        pytest.skip("no livekit image pinned in docker-compose.yml to start")
    if shutil.which("docker") is None:
        pytest.skip(
            "no LiveKit project named and no docker to start one: set "
            "TEST_LIVEKIT_URL with its key pair, or install docker"
        )
    url = "ws://127.0.0.1:7880"
    if _answering(url):
        pytest.skip(
            "something already answers on 127.0.0.1:7880, so this cannot "
            "start its own server there and will not talk to one it did "
            "not start; stop it, or name a server with TEST_LIVEKIT_URL"
        )

    name = f"egma-livekit-tests-{os.getpid()}"
    started = subprocess.run(
        # Host networking because a room's media negotiates addresses of its
        # own, and a published port would advertise one this machine cannot
        # reach from inside the container's own view of itself.
        ["docker", "run", "-d", "--rm", "--name", name, "--network", "host",
         image, "--dev", "--bind", "0.0.0.0"],
        capture_output=True,
        text=True,
        check=False,
    )
    if started.returncode != 0:
        pytest.skip(f"docker could not start {image}: {started.stderr.strip()[:200]}")

    try:
        deadline = time.monotonic() + LIVEKIT_HEALTH_SECONDS
        while not _answering(url):
            if time.monotonic() > deadline:
                logs = subprocess.run(
                    ["docker", "logs", "--tail", "20", name],
                    capture_output=True, text=True, check=False,
                )
                pytest.fail(
                    f"{image} did not answer on {url} within "
                    f"{LIVEKIT_HEALTH_SECONDS:.0f}s: {logs.stderr.strip()[:400]}"
                )
            time.sleep(0.2)
        yield LiveKit(url, LIVEKIT_DEV_KEY, LIVEKIT_DEV_SECRET)
    finally:
        subprocess.run(
            ["docker", "stop", name], capture_output=True, check=False
        )
