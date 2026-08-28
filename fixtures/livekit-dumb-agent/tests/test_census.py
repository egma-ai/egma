"""What egma would be told this agent has, and when.

The census is read off the agent object at the moment ``mockable`` runs,
so two things have to be true of this file and neither is obvious from
reading it: the tools must be **attached before** that line, and there
must be **two of them** — one for a mock tool to answer for, one for
nothing to answer for.

The second is the whole reason ``opening_hours`` exists. A coverage stamp
with nothing uncovered on it cannot say the thing the stamp is for, which
is *this simulation was not fully isolated, and here is what was left
out*. Delete that tool and the live proof quietly loses half its record —
so the count is asserted here rather than trusted to survive a tidy-up.
"""

from __future__ import annotations

import asyncio
import inspect

from conftest import inside_egma, tools_on
from egma import mockable, monitoring

from agent import FrontDesk

MOCKABLE_TOOL = "check_availability"
"""The booking-shaped one: what a live test mocks to force a branch."""

UNMOCKED_TOOL = "opening_hours"
"""The other one: what stays uncovered, so the stamp has both halves."""


def test_the_agent_carries_both_tools_before_anything_is_wrapped():
    assert set(tools_on(FrontDesk())) == {MOCKABLE_TOOL, UNMOCKED_TOOL}


async def test_this_agent_reports_its_tools_when_egma_walks_in_second(session):
    """The dispatch path this fixture is silent on unless the SDK waits.

    This worker registers unnamed by default, so nothing dispatches it on
    egma's behalf: LiveKit walks it into the room as soon as the room
    exists, which is before egma's own participant is in it. The room's
    name is what says this is a simulation, and it says so from the first
    line of the entrypoint — so the census still goes, and it goes to the
    participant that arrives afterwards.
    """
    agent = FrontDesk()
    context = inside_egma()

    async def egma_walks_in() -> None:
        await asyncio.sleep(0.05)
        context.room.arrive("egma-persona")

    joining = asyncio.create_task(egma_walks_in())
    await mockable(agent, context, session)
    await joining

    assert context.room.asked == ["egma.hello"]


def test_the_booking_shaped_tool_takes_the_day_it_is_asked_about():
    """The one parameter, by name.

    egma copies this signature onto the stand-in it registers, because
    LiveKit trims a call to the parameters the stand-in declares. So the
    name here is what lands on the record as the call's arguments — rename
    it and a live record's ``egma.tool.arguments`` changes shape with it.
    """
    parameters = inspect.signature(FrontDesk.check_availability).parameters
    assert [name for name in parameters if name != "self"] == ["day"]


def test_mockable_is_called_after_both_objects_exist_and_before_the_session_starts():
    """The call site, read off the source of the entrypoint itself.

    Order is the whole of the integration contract: earlier than the
    agent and the census reports tools that are not there yet; later than
    ``session.start`` and the agent may already have taken a call. Both
    mistakes leave a working-looking worker, which is why this is a test
    and not a comment.
    """
    from agent import entrypoint

    body = inspect.getsource(entrypoint)
    lines = [line.strip() for line in body.splitlines()]
    def line_of(said: str) -> int:
        found = [i for i, line in enumerate(lines) if said in line]
        # Named rather than left to raise on an empty sequence: what goes
        # wrong here is somebody renaming a line in `agent.py`, and the
        # useful failure says which line went missing.
        assert found, f"no line of entrypoint() carries {said!r}: {lines}"
        return found[0]

    said = line_of("await mockable(")
    built_agent = line_of("agent = FrontDesk()")
    built_session = line_of("session = AgentSession(")
    started = line_of("await session.start(")

    assert built_agent < said
    assert built_session < said
    assert said < started


def test_monitoring_is_configured_before_livekit_opens_the_room():
    """LiveKit must receive the provider before it creates its first span."""

    from agent import entrypoint

    body = inspect.getsource(entrypoint)
    configured = body.index("monitor_livekit(ctx)")
    connected = body.index("await ctx.connect()")
    started = body.index("await session.start(")

    assert configured < connected < started


def test_the_supported_livekit_version_exposes_its_current_provider():
    """The SDK reuses this provider so it cannot erase Cloud observability."""

    assert monitoring._livekit_provider() is not None
def test_the_six_lines_key_on_the_marked_room_name_before_the_session_starts():
    """The chat decision, read off the source of the entrypoint itself.

    The mark is written out by hand here, exactly as egma's own suite
    writes it, because it is a published contract and not a constant to
    import: a chat simulation's room begins ``egma-sim-chat-``, the name
    arrives with the job before the worker connects to anything, and the
    six lines have decided their room options off it by the time the
    session starts. Read a failure here as the contract refusing to move.

    The customer's metadata channels stay the customer's: nothing in the
    entrypoint reads ``ctx.job.metadata`` or ``ctx.room.metadata``, so no
    key anybody configures — a ``modality`` of their own included — can
    reach into this decision.
    """
    from agent import entrypoint

    body = inspect.getsource(entrypoint)
    lines = [line.strip() for line in body.splitlines()]

    def line_of(said: str) -> int:
        found = [i for i, line in enumerate(lines) if said in line]
        assert found, f"no line of entrypoint() carries {said!r}: {lines}"
        return found[0]

    decided = line_of('chat = ctx.job.room.name.startswith("egma-sim-chat-")')
    started = line_of("await session.start(")
    assert decided < started

    assert "ctx.job.metadata" not in body
    assert "ctx.room.metadata" not in body
