"""Both tools must exist before simulation() reads the inventory.
Keep one tool for mocked execution and another for its real fixture implementation.
"""

from __future__ import annotations

import asyncio
import inspect

from conftest import inside_egma, tools_on
from egma import export, simulation

from agent import FrontDesk

MOCKABLE_TOOL = "check_availability"
"""The booking-shaped one: what a live test mocks to force a branch."""

UNMOCKED_TOOL = "opening_hours"
"""The other one: what no test names, so a run has both halves in it."""


def test_the_agent_carries_both_tools_before_anything_is_wrapped():
    assert set(tools_on(FrontDesk())) == {MOCKABLE_TOOL, UNMOCKED_TOOL}


async def test_this_agent_reports_its_tools_when_egma_walks_in_second(
    session, egma_export
):
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
    await simulation(agent, context, session)
    await joining

    assert context.room.asked == ["egma.hello"]


def test_the_booking_shaped_tool_takes_the_day_it_is_asked_about():
    """The one parameter, by name.

    egma copies this signature onto the stand-in it registers, because
    LiveKit trims a call to the parameters the stand-in declares. So the
    name here is what the agent's own span reports as the call's
    arguments — rename it and a live record changes shape with it.
    """
    parameters = inspect.signature(FrontDesk.check_availability).parameters
    assert [name for name in parameters if name != "self"] == ["day"]


def test_the_verb_is_called_after_both_objects_exist_and_before_the_session_starts():
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

    said = line_of("await simulation(")
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
    configured = body.index("monitor(ctx)")
    connected = body.index("await ctx.connect()")
    started = body.index("await session.start(")

    assert configured < connected < started


def test_the_supported_livekit_version_exposes_its_current_provider():
    """The SDK reuses this provider so it cannot erase Cloud observability."""

    assert export._livekit_provider() is not None
def test_the_six_lines_key_on_the_marked_room_name_before_the_session_starts():
    """Pin chat selection to the published egma-sim-chat- literal in the entrypoint.
    Only the room name may select modality; customer metadata must not affect it.
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
    assert "metadata" not in lines[decided]

    assert "ctx.room.metadata" not in body


def test_the_agent_reads_the_tests_own_world_off_its_dispatch():
    """The customer-side half of a test's env, proved without a room.

    Egma writes a test's ``job_dispatch_metadata`` onto the agent dispatch
    as one compact JSON string, and this is the reading of it that the
    live proof watches for on the far side. What is held here is the read
    itself and its forgiveness, because a worker that raised on an empty
    or malformed channel would be a worker that stopped answering the
    phone in production over a value nobody sent.
    """
    from agent import TENANT_KEY, dispatched_world

    # What egma writes for a test that wrote {"tenant": "acme"}.
    assert dispatched_world('{"tenant":"acme","caller_id":"+15550100"}') == {
        "tenant": "acme",
        "caller_id": "+15550100",
    }
    assert dispatched_world('{"tenant":"acme"}')[TENANT_KEY] == "acme"

    # And every shape a production room hands the same worker.
    for nothing_to_read in ("", "   ", "not json at all", "[1, 2]", '"acme"'):
        assert dispatched_world(nothing_to_read) == {}


def test_the_dispatched_world_is_logged_and_never_spoken():
    """A test's world goes to the log; the transcript stays the caller's.

    What a test writes on this channel is the world the agent starts in,
    never the script it is about to be asked — so a fixture that spoke it
    would put a word on the transcript that nobody said, and the live
    proof would then be reading its own value back out of the very
    transcript it is grading.
    """
    from agent import entrypoint

    body = inspect.getsource(entrypoint)
    assert "logger.info(" in body
    assert "dispatched_world(ctx.job.metadata)" in body
    # The value never reaches anything the caller hears.
    said = body[body.index("await session.generate_reply(") :]
    assert "world" not in said
