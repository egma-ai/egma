"""Serve test-owned mock-tool answers resolved in the claimed simulation spec.

egma.hello validates the wire version and replaces the cumulative tool census
at startup or handoff. Its reply names the fixed tools to wrap. egma.tool
returns the authored answer or error tag and refuses unknown names.
Handlers use JSON strings and MockToolRefusal without depending on LiveKit.

The agent SDK records LiveKit tool-call spans; these handlers do not duplicate
that evidence. For platforms that serve mocks themselves, answers() supplies
the values and reported() records observed calls without measured duration.
Only covered names include Egma's authored answer in that record.
Display derives mock coverage from the pinned test version by tool name.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from .spec import MockTool

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
"""Wire version checked in both hello directions. SDK and simulator tests share
packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json.
For a shape change, add a new fixture and deploy simulator support for both
versions before releasing an SDK that sends the new version.
"""

HELLO_METHOD = "egma.hello"
"""Where a session announces itself and learns what egma answers for."""

NOT_REPORTED = (
    "the agent did not report to Egma: no egma.hello arrived from the "
    "worker's session, so this simulation isolated nothing and its record "
    "would say nothing about the tools it ran. The Egma SDK is required for "
    "a LiveKit simulation — check that the worker can reach the room and "
    "that Egma's participant was in it, and check that `egma.simulation` is "
    "called on the agent's session before it starts"
)
"""Shared error for a hello that never arrived. Use REPORTED_AND_REFUSED when
Egma received and rejected hello so the developer investigates the correct fault.
"""

REPORTED_AND_REFUSED = (
    "the agent reported to Egma and Egma refused the report ({why}), so no "
    "tool was isolated and this simulation ran against whatever the agent's "
    "own tools do. The refusal is Egma's own, so the worker is wired up "
    "correctly and what to look at is the reason above — most often a test "
    "whose mock tools do not fit in one message, or a worker and an Egma "
    "that speak different versions of the exchange"
)
"""What a simulation ends on where Egma answered the hello with a refusal.

The other half of :data:`NOT_REPORTED`, and the half a bare "did not
report" gets badly wrong: the SDK did call, the message did arrive, and
the fault is on Egma's side of the exchange or in the test's own mock
tools. Carries Egma's own words for why, because those are the half this
sentence cannot know.
"""

TOOL_METHOD = "egma.tool"
"""Where one tool call is asked and answered."""

LARGEST_PAYLOAD_BYTES = 15 * 1024
"""RPC payload limit in UTF-8 bytes, including the serialized answer/error tag.
Recheck at serving time so an oversized answer gets a clear application refusal.
"""

MALFORMED_REQUEST = 901
"""A message this exchange cannot read at all."""

UNKNOWN_TOOL = 902
"""A call for a name this simulation has no answer for."""

ANSWER_TOO_LARGE = 903
"""An answer that would not fit on the wire."""

UNSUPPORTED_PROTOCOL_VERSION = 904
"""A hello in a version of this exchange egma does not speak."""

# 901-999 are egma's own, deliberately clear of 1001-1999, which the
# transport reserves for the errors it raises itself — a method nobody
# registered, a recipient that is not there, a payload too large for it to
# carry. Two blocks that cannot collide means an error code always says
# whose complaint it is.

class MockToolRefusal(Exception):
    """egma refusing one message of the exchange, in its own words.

    Carries a code the other side can branch on and a sentence a person
    can act on. Whoever registered the handlers turns it into the
    transport's own error — so the exchange's refusals are the same
    refusals whatever carries them.
    """

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ReportedToolCall:
    """One call a platform says the agent made, and what egma authored for it.

    One instant, not an interval: egma did not conduct this exchange and
    did not time it, so there is no round trip to bracket and no duration
    to claim.
    """

    name: str
    """The tool's name, exactly as the platform reported it."""

    arguments: str | None
    """The arguments as JSON, or ``None`` where the report carried none."""

    answer: str | None
    """What the call was given, JSON-encoded — egma's own rendering of the
    answer it authored, and ``None`` for a name this simulation has no
    answer for, whose return value is the customer's backend's rather
    than egma's to vouch for."""

    at_unix_nano: int


@dataclass(frozen=True)
class AuthoredAnswer:
    """One mock tool's answer, rendered for a platform that serves it.

    The whole of what a lane needs to hand egma's answers to somebody
    else: the name they are matched by, the bytes the tool is given, and
    whether the answer is the failure branch — which such a platform says
    its own way, because it is the one serving.
    """

    tool_name: str
    """The agent's own name for the tool, verbatim — the whole of how a
    call is matched, and never parsed or folded."""

    served: str
    """The value the tool is given, JSON-encoded: the tool's own return
    value, or — where the answer is the failure branch — the failure it
    raises. Untagged, because the tag is how the room exchange tells a
    return from a raise, and a platform serving the answer itself says
    which one it is in its own words.

    It is also what a lane can hold a platform to: a plug that sees what
    the tool was really given can compare it with this before letting the
    record claim egma answered."""

    fails: bool
    """Whether this answer is the failure branch."""


Clock = Callable[[], int]
"""Wall-clock nanoseconds, which is what a span's timestamp is."""


class MockToolSeam:
    """egma's side of the mock-tool exchange, for one simulation.

    Built from the claimed spec's resolved answers and handed to whatever
    puts it in front of the agent. It holds three things and no more: the
    answers, the census it was told, and the calls a platform has
    reported since somebody last took them. A call it conducts itself is
    written down nowhere — that record is the agent's own POV of the
    simulation.
    """

    def __init__(
        self,
        mock_tools: tuple[MockTool, ...] = (),
        *,
        clock: Clock = time.time_ns,
    ) -> None:
        self._answers = {mock.tool_name: mock for mock in mock_tools}
        self._clock = clock
        self._censuses = 0
        self._refused_report: str | None = None
        self._discovered: tuple[str, ...] = ()
        self._reported: list[ReportedToolCall] = []

    # -- What the driver does with it -----------------------------------------

    @property
    def agent_reported(self) -> bool:
        """Whether at least one hello was accepted. Required for LiveKit simulation
        startup.
        A refused hello does not count; why_unreported distinguishes refusal from
        absence.
        """
        return self._censuses > 0

    @property
    def why_unreported(self) -> str:
        """Why this simulation has no agent report, in the words to act on.

        Two answers, because they send a developer to opposite halves of
        the system: a hello that never arrived is a worker with no SDK call
        in it, and a hello Egma refused is a fault on Egma's own side or in
        the test's mock tools. Read where a plug has already found that
        :attr:`agent_reported` is false.
        """
        if self._refused_report is None:
            return NOT_REPORTED
        return REPORTED_AND_REFUSED.format(why=self._refused_report)

    def exchanged(self) -> list[ReportedToolCall]:
        """Every reported call since this was last asked, and then none.

        Drained rather than accumulated, so whoever authors spans from
        them can ask as often as it likes and no call is ever written
        down twice.
        """
        taken, self._reported = self._reported, []
        return taken

    # -- What a platform that serves egma's answers itself uses ---------------

    def answers(self) -> tuple[AuthoredAnswer, ...]:
        """Every answer this simulation holds, rendered once.

        For the lane where the platform matches and serves them itself:
        what it needs is the answers, not a handler. Rendered here rather
        than by whoever sends them, so two lanes cannot spell one authored
        answer two ways and leave a reader comparing bytes that only look
        different.
        """
        return tuple(
            AuthoredAnswer(
                tool_name=mock.tool_name,
                served=_serialized(mock.answer["error" if mock.fails else "answer"]),
                fails=mock.fails,
            )
            for mock in self._answers.values()
        )

    def reported(self, name: str, *, arguments: str | None = None) -> None:
        """Record a platform-reported tool call at one instant; no duration was
        observed.
        For covered names, include Egma's rendered answer instead of the platform echo.
        For uncovered names, record the name and arguments without a result.
        """
        called = name.strip()
        if not called:
            raise ValueError("a tool call the platform reported must name a tool")
        if called not in self._discovered:
            self._discovered = (*self._discovered, called)
        mock = self._answers.get(called)
        self._reported.append(
            ReportedToolCall(
                name=called,
                arguments=arguments,
                answer=None if mock is None else _recorded(mock),
                at_unix_nano=self._clock(),
            )
        )

    # -- The two methods ------------------------------------------------------

    async def hello(self, payload: str) -> str:
        """The census in, the names egma answers for out.

        A second hello replaces the first rather than adding to it: the
        census is a snapshot of the agent's tools, and an agent that
        re-announces itself is announcing what it has *now*.
        """
        try:
            return await self._hello(payload)
        except MockToolRefusal as refused:
            # Remembered, not counted: a refused hello is not a report —
            # it told the agent nothing, so nothing was wrapped — but it
            # is a *different* failure from silence, and a simulation that
            # ended saying "check that egma.simulation is called" when the
            # SDK called and Egma said no sends a developer to the wrong
            # half of the system.
            self._refused_report = refused.message
            raise

    async def _hello(self, payload: str) -> str:
        asked = _object(HELLO_METHOD, payload)
        _speaks_this_version(asked)

        census = asked.get("tools")
        if not isinstance(census, list):
            raise MockToolRefusal(
                MALFORMED_REQUEST,
                f"{HELLO_METHOD} carries the agent's tools as a list of "
                '{"name": …} objects, and this one carries '
                f"{_kind_of(census)}",
            )
        discovered: list[str] = []
        for entry in census:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not name.strip():
                raise MockToolRefusal(
                    MALFORMED_REQUEST,
                    f"every tool in an {HELLO_METHOD} census names itself: "
                    'each entry is {"name": "the_tool", "schema": …} and one '
                    f"of these carries {_kind_of(name)} for its name",
                )
            name = name.strip()
            if name not in discovered:
                discovered.append(name)

        reply = _serialized(
            {
                "protocol_version": PROTOCOL_VERSION,
                "mocked_tools": list(self._answers),
            }
        )
        # Measured before the census is kept: a reply that cannot be sent
        # tells the other side nothing, so it wraps nothing, and a census
        # taken ahead of the refusal would leave this side believing it
        # had been told what the agent holds. A test naming more mocked
        # tools than one message can carry is also a fault worth naming,
        # where the transport's own complaint would arrive as a hello that
        # mysteriously failed.
        _fits_on_the_wire("the list of tools Egma answers for", reply)

        replaced = self._censuses
        self._censuses += 1
        replacing = self._discovered
        self._discovered = tuple(discovered)
        logger.info(
            "the agent reported %d tool(s); %d of them are answered by mock "
            "tools",
            len(self._discovered),
            sum(1 for name in self._discovered if name in self._answers),
        )
        if replaced:
            # A census is a snapshot of the agent's tools, so a second one
            # is the agent saying what it has *now*. Said out loud because
            # only the last one is kept, and an operator surprised by which
            # tools egma answered for deserves to find the moment the
            # census changed.
            logger.info(
                "a second census replaced the first: %d tool(s) became %d",
                len(replacing),
                len(self._discovered),
            )
        return reply

    async def tool(self, payload: str) -> str:
        """One tool call: answered at once, and written down nowhere.

        What the agent asked for and what it was given is on the agent's
        own POV of the simulation, one row per call. This side only
        serves.
        """
        asked = _object(TOOL_METHOD, payload)

        name = asked.get("name")
        if not isinstance(name, str) or not name.strip():
            raise MockToolRefusal(
                MALFORMED_REQUEST,
                f"{TOOL_METHOD} names the tool being called, and this one "
                f"names {_kind_of(name)}",
            )
        name = name.strip()

        arguments = asked.get("arguments")
        if arguments is not None and not isinstance(arguments, dict):
            raise MockToolRefusal(
                MALFORMED_REQUEST,
                f"{TOOL_METHOD} carries the call's arguments as a JSON "
                f"object or not at all, and {name} carried {_kind_of(arguments)}",
            )

        mock = self._answers.get(name)
        if mock is None:
            # Never a pass-through. The other side was told which names
            # egma answers for, so a call for any other name is that side
            # asking for something it was never offered; answering it
            # anyway, or waving it through, would run the customer's real
            # tool from inside a test that asked egma to stand in front of
            # it. The refusal reaches the model as that tool failing, and
            # the agent's own span for the call carries the error — which
            # is where a reader finds it.
            offered = ", ".join(self._answers) or "no tools at all"
            logger.warning(
                "a call for %r reached Egma, which has no answer for it; the "
                "hello reply named %s. Refused rather than waved through: a "
                "call Egma cannot answer is not a call Egma answered",
                name,
                offered,
            )
            raise MockToolRefusal(
                UNKNOWN_TOOL,
                f"this simulation has no mock tool for {name!r}, so Egma has "
                f"nothing to answer with. It answers for: {offered}",
            )

        # The answer travels tagged — ``{"answer": …}`` or
        # ``{"error": …}`` — because the other side has to know whether to
        # return this to the model or raise it, and an authored value that
        # happened to look like a failure would otherwise be one. What the
        # agent then did with it is the agent's own span to say.
        served = _serialized(mock.answer)
        _fits_on_the_wire(f"the mock tool for {name!r}", served)
        return served


# -- Reading one message of the exchange -------------------------------------


def _object(method: str, payload: str) -> dict:
    """One message, as the JSON object it has to be."""
    try:
        asked = json.loads(payload)
    except ValueError as unreadable:
        raise MockToolRefusal(
            MALFORMED_REQUEST,
            f"{method} carries a JSON object, and this payload is not JSON: "
            f"{unreadable}",
        ) from unreadable
    if not isinstance(asked, dict):
        raise MockToolRefusal(
            MALFORMED_REQUEST,
            f"{method} carries a JSON object, and this payload carries "
            f"{_kind_of(asked)}",
        )
    return asked


def _speaks_this_version(asked: dict) -> None:
    """A hello in a version egma does not speak is refused at the door.

    The version is the one field of this exchange a refusal quotes back
    rather than naming by kind: it is the protocol's own number, not the
    customer's data, and whoever has to fix the mismatch needs to see
    which two versions did not meet.
    """
    version = asked.get("protocol_version")
    if version == PROTOCOL_VERSION:
        return
    declared = (
        repr(version)
        if isinstance(version, int) and not isinstance(version, bool)
        else _kind_of(version)
    )
    raise MockToolRefusal(
        UNSUPPORTED_PROTOCOL_VERSION,
        f"{HELLO_METHOD} declares which version of this exchange it speaks; "
        f"Egma speaks {PROTOCOL_VERSION} and this one declared {declared}",
    )


def _recorded(mock: MockTool) -> str:
    """Record successful return values without the wire tag; keep the tag for failures.
    An answer object with an error key remains indistinguishable from a mocked
    failure in this representation.
    """
    return _serialized(mock.answer if mock.fails else mock.answer["answer"])


def _serialized(value: object) -> str:
    """One JSON document, in the compact shape everything else here uses.

    Non-ASCII characters are written as themselves rather than escaped,
    because the cap this is measured against is counted in bytes of UTF-8
    on both sides of the seam. Python's default would spend six bytes on a
    character the wire carries in two, and an answer sized against the cap
    where it was authored would be refused here for text nobody else
    counts that way.
    """
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _fits_on_the_wire(what: str, message: str) -> None:
    """Refuse a message the transport could not carry, before it is sent.

    Refused here rather than by the transport, because the transport's own
    complaint arrives at the far side as a call that mysteriously failed,
    where this one names the thing that outgrew the message.
    """
    bytes_over_the_wire = len(message.encode())
    if bytes_over_the_wire <= LARGEST_PAYLOAD_BYTES:
        return
    raise MockToolRefusal(
        ANSWER_TOO_LARGE,
        f"{what} is {bytes_over_the_wire} bytes, and one message of this "
        f"exchange holds at most {LARGEST_PAYLOAD_BYTES}. An answer that "
        "needs more than that is a document rather than a tool answer",
    )


def _kind_of(value: object) -> str:
    """What arrived, named by kind rather than quoted.

    A refusal says what shape it got, never the bytes it got: the payload
    is the customer's own data and a message about it travels into logs.
    """
    if value is None:
        return "nothing"
    return {
        bool: "a boolean",
        int: "a number",
        float: "a number",
        str: "text",
        list: "a list",
        dict: "an object",
    }.get(type(value), "something else")
