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

import inspect

from conftest import tools_on

from agent import FrontDesk

MOCKABLE_TOOL = "check_availability"
"""The booking-shaped one: what a live test mocks to force a branch."""

UNMOCKED_TOOL = "opening_hours"
"""The other one: what stays uncovered, so the stamp has both halves."""


def test_the_agent_carries_both_tools_before_anything_is_wrapped():
    assert set(tools_on(FrontDesk())) == {MOCKABLE_TOOL, UNMOCKED_TOOL}


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
        return next(i for i, line in enumerate(lines) if said in line)

    said = line_of("await mockable(")
    built_agent = line_of("agent = FrontDesk()")
    built_session = line_of("session = AgentSession(")
    started = line_of("await session.start(")

    assert built_agent < said
    assert built_session < said
    assert said < started
