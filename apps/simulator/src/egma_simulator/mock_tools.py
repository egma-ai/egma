"""Mock tools: egma answering for the agent's own tools, at the seam.

A **mock tool** answers for one of the agent's tools while a simulation
runs, so the agent's real backend is never touched and a test can order up
the branch it needs — an empty calendar, a booking that errors, a lookup
that takes three seconds. Which tools this simulation answers for, and
what each answers with, arrives on the claimed spec already resolved: one
world per run, worked out once, nothing here to merge and nothing to
disagree about.

## The exchange

egma is already a participant in the room. So the agent's side asks egma,
in the room, before anything real runs — two methods and no more:

- **``egma.hello``** — sent once when the agent's session starts. It
  carries the protocol version and the census: every tool the agent has,
  by name, with its schema. egma writes the census down and answers with
  the names it will be answering for, so the other side wraps exactly
  those and leaves every other tool alone.
- **``egma.tool``** — one per call the agent makes to a wrapped tool. It
  carries the tool's name and the arguments. egma waits the mock tool's
  declared delay, answers with the pinned answer, and writes the whole
  exchange down: what was asked, what was served, and how long it took.

Both directions are JSON objects in a string, because that is what the
transport carries, and the answer travels in **the shape it was authored
in** — ``{"answer": …}`` or ``{"error": …}`` — from the authoring row,
through the run's snapshot, through the claimed spec, onto the wire. One
shape end to end means nothing in between re-tags it, and nothing in
between can invent a difference.

## Nothing here knows about LiveKit

The two handlers take a payload string and answer with one; a refusal is
:class:`MockToolRefusal`, which whoever registered them turns into their
transport's own error. That is what keeps the exchange — report the call,
receive an answer — a contract rather than a room feature, and it is why
the room driver can register these against a real LiveKit and a
room-shaped fake alike with nothing here changing.

## What lands on the record

Every call egma answers becomes a ``tool_call`` span: the name, the
arguments as they arrived, the answer as it was served, the provenance
stamp, and the mock tool that answered. The span brackets the exchange —
the round trip plus the declared delay — so a delay is readable as the
time it really took, with no second field to disagree with it.

A call served for a tool the census never named is flagged
**late-attached**: answers stand ready for every name this simulation
covers whether or not the census mentioned it, which is the safe way
round, and the flag carries the caveat that such a call's arguments may
be thin.

A call for a name **outside** this simulation's answers is refused, on
the wire and on the record. It is a protocol error — the other side was
told exactly which names egma answers for — and quietly letting it
through would put a call egma never answered on the record as one it did.

The simulation's terminal facts carry the **coverage stamp**: which tools
the agent reported, which egma stood ready for, and which ran their own
implementations untouched. It is the only place a reader learns a
simulation was not fully isolated.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .spec import MockTool

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
"""Which version of this exchange egma's participant speaks.

It rides the dispatch metadata so the other side knows before it says
anything, and it rides every hello in both directions so a mismatch is
refused at the first message rather than discovered halfway through a
conversation.
"""

HELLO_METHOD = "egma.hello"
"""Where a session announces itself and learns what egma answers for."""

TOOL_METHOD = "egma.tool"
"""Where one tool call is asked and answered."""

LARGEST_PAYLOAD_BYTES = 15 * 1024
"""How much one message of this exchange may carry, in bytes of UTF-8.

The transport's own limit, written down here because egma has to refuse
an answer it cannot send *as an answer about that answer* — a refusal
naming the size and the cap is something an author can act on, where the
transport's own complaint arrives at the far end as a call that mysteriously
failed. Authoring already refuses an answer this large, so reaching it here
means a cap moved somewhere; it is checked anyway, because the alternative
is finding out during somebody's simulation.
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

MOCKED = "mocked"
"""The one provenance a served call carries: a mock tool answered it."""


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
class ExchangedToolCall:
    """One call that reached egma, and what egma did with it.

    Both ends are instants on the wall clock: an exchange egma conducted
    is timed by egma, unlike a turn, which is read off the audio. The span
    it becomes brackets exactly this — the round trip plus whatever delay
    the mock tool declared.
    """

    name: str
    """The tool's name, exactly as the call reported it."""

    arguments: str | None
    """The arguments as JSON, or ``None`` where the call carried none."""

    answer: str | None
    """The answer as it was served, JSON-encoded — or ``None`` for a call
    egma refused, which is a call nobody was answered about."""

    mock_tool: str | None
    """The mock tool that answered, by name. ``None`` exactly where
    :attr:`answer` is: a result is never recorded without the stamp that
    says where it came from."""

    late_attached: bool
    """True where the census never named this tool. Absent from the record
    otherwise: a stamp for the ordinary case would ride every span."""

    began_unix_nano: int
    ended_unix_nano: int


Sleep = Callable[[float], Awaitable[None]]
"""How the declared delay is spent. Injected so a suite can hold it."""

Clock = Callable[[], int]
"""Wall-clock nanoseconds, which is what a span's two ends are."""


class MockToolSeam:
    """egma's side of the mock-tool exchange, for one simulation.

    Built from the claimed spec's resolved answers and handed to whatever
    puts it in front of the agent. It holds three things and no more: the
    answers, the census it was told, and the calls it has exchanged since
    somebody last took them.
    """

    def __init__(
        self,
        mock_tools: tuple[MockTool, ...] = (),
        *,
        clock: Clock = time.time_ns,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self._answers = {mock.tool_name: mock for mock in mock_tools}
        self._clock = clock
        self._sleep = sleep
        self._standing_ready = False
        self._spoken_to = False
        self._discovered: tuple[str, ...] = ()
        self._exchanged: list[ExchangedToolCall] = []

    # -- What the driver does with it -----------------------------------------

    def standing_ready(self) -> None:
        """The handlers are in front of the agent; egma is in the tool path.

        Said by whoever registered them, and it is what decides whether the
        record carries a coverage stamp at all. A simulation whose room was
        never joined has no stamp to make: egma was not there, so it learned
        nothing and claims nothing.
        """
        self._standing_ready = True

    def exchanged(self) -> list[ExchangedToolCall]:
        """Every call since this was last asked, and then none.

        Drained rather than accumulated, so a caller authoring spans from
        them can be called as often as it likes and no call is ever
        written down twice.
        """
        taken, self._exchanged = self._exchanged, []
        return taken

    def coverage(self) -> dict | None:
        """The coverage stamp, or nothing where there is nothing to claim.

        ``None`` where egma never stood in the tool path — the honest
        reading of every connection egma is not in the path of, and of a
        room that was never joined.

        Three empty lists where it stood ready and nobody ever spoke to
        it: the asking happened, and no tool came back. Where somebody did
        speak, ``covered`` is every name egma stood ready to answer for —
        which is exactly what the hello reply told them — and ``uncovered``
        is the discovered names left over, the tools that ran their own
        implementations untouched and unobserved.
        """
        if not self._standing_ready:
            return None
        covered = tuple(self._answers) if self._spoken_to else ()
        return {
            "discovered": list(self._discovered),
            "covered": list(covered),
            "uncovered": [
                name for name in self._discovered if name not in set(covered)
            ],
        }

    # -- The two methods ------------------------------------------------------

    async def hello(self, payload: str) -> str:
        """The census in, the names egma answers for out.

        A second hello replaces the first rather than adding to it: the
        census is a snapshot of the agent's tools, and an agent that
        re-announces itself is announcing what it has *now*.
        """
        # Set before anything is read, on both methods, because what it
        # answers is "did anything speak this exchange to egma at all" —
        # and a session whose hello egma could not read is still a session
        # that was there. It is the difference between a stamp saying no
        # tool came back and one saying nobody ever asked.
        self._spoken_to = True
        asked = _object(HELLO_METHOD, payload)
        _speaks_this_version(asked)

        census = asked.get("tools")
        if not isinstance(census, list):
            raise MockToolRefusal(
                MALFORMED_REQUEST,
                f"{HELLO_METHOD} carries the agent's tools as a list of "
                '{"name": …} objects, and this one carries '
                f"{_named(census)}",
            )
        discovered: list[str] = []
        for entry in census:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not name.strip():
                raise MockToolRefusal(
                    MALFORMED_REQUEST,
                    f"every tool in an {HELLO_METHOD} census names itself: "
                    'each entry is {"name": "the_tool", "schema": …} and one '
                    f"of these carries {_named(name)} for its name",
                )
            name = name.strip()
            if name not in discovered:
                discovered.append(name)

        self._discovered = tuple(discovered)
        logger.info(
            "the agent reported %d tool(s); %d of them are answered by mock "
            "tools",
            len(self._discovered),
            sum(1 for name in self._discovered if name in self._answers),
        )
        return _serialized(
            {
                "protocol_version": PROTOCOL_VERSION,
                "mocked_tools": list(self._answers),
            }
        )

    async def tool(self, payload: str) -> str:
        """One tool call: waited out, answered, and written down."""
        began = self._clock()
        self._spoken_to = True
        asked = _object(TOOL_METHOD, payload)

        name = asked.get("name")
        if not isinstance(name, str) or not name.strip():
            raise MockToolRefusal(
                MALFORMED_REQUEST,
                f"{TOOL_METHOD} names the tool being called, and this one "
                f"names {_named(name)}",
            )
        name = name.strip()

        arguments = asked.get("arguments")
        if arguments is not None and not isinstance(arguments, dict):
            raise MockToolRefusal(
                MALFORMED_REQUEST,
                f"{TOOL_METHOD} carries the call's arguments as a JSON "
                f"object or not at all, and {name} carried {_named(arguments)}",
            )
        written = None if arguments is None else _serialized(arguments)

        mock = self._answers.get(name)
        if mock is None:
            # Never a pass-through. The other side was told which names
            # egma answers for, so a call for any other name is that side
            # asking for something it was never offered — and answering it
            # anyway, or waving it through, would put a tool egma had no
            # answer for on the record as one it served.
            self._write_down(
                ExchangedToolCall(
                    name=name,
                    arguments=written,
                    answer=None,
                    mock_tool=None,
                    late_attached=False,
                    began_unix_nano=began,
                    ended_unix_nano=self._clock(),
                )
            )
            offered = ", ".join(self._answers) or "no tools at all"
            logger.warning(
                "a call for %r reached egma, which has no answer for it; the "
                "hello reply named %s. Refused rather than waved through: a "
                "call egma cannot answer is not a call egma answered",
                name,
                offered,
            )
            raise MockToolRefusal(
                UNKNOWN_TOOL,
                f"this simulation has no mock tool for {name!r}, so egma has "
                f"nothing to answer with. It answers for: {offered}",
            )

        # The answer is the reply: the tagged object travels as authored,
        # so what goes on the wire is the same bytes the record keeps.
        served = _serialized(mock.answer)
        _fits_on_the_wire(name, served)
        if mock.delay_milliseconds:
            await self._sleep(mock.delay_milliseconds / 1000)

        self._write_down(
            ExchangedToolCall(
                name=name,
                arguments=written,
                answer=served,
                mock_tool=mock.tool_name,
                late_attached=name not in self._discovered,
                began_unix_nano=began,
                ended_unix_nano=self._clock(),
            )
        )
        return served

    def _write_down(self, call: ExchangedToolCall) -> None:
        self._exchanged.append(call)


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
            f"{_named(asked)}",
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
        else _named(version)
    )
    raise MockToolRefusal(
        UNSUPPORTED_PROTOCOL_VERSION,
        f"{HELLO_METHOD} declares which version of this exchange it speaks; "
        f"egma speaks {PROTOCOL_VERSION} and this one declared {declared}",
    )


def _serialized(value: object) -> str:
    """One JSON document, in the compact shape everything else here uses."""
    return json.dumps(value, separators=(",", ":"))


def _fits_on_the_wire(name: str, served: str) -> None:
    """Refuse an answer the transport could not carry, before it is waited for.

    Measured before the delay is spent rather than after: an answer that
    cannot be sent is a fault to raise at once, not something to make a
    conversation wait three seconds for.
    """
    bytes_over_the_wire = len(served.encode())
    if bytes_over_the_wire <= LARGEST_PAYLOAD_BYTES:
        return
    raise MockToolRefusal(
        ANSWER_TOO_LARGE,
        f"the mock tool for {name!r} answers with {bytes_over_the_wire} "
        f"bytes, and one message of this exchange holds at most "
        f"{LARGEST_PAYLOAD_BYTES}. An answer that needs more than that is a "
        "document rather than a tool answer",
    )


def _named(value: object) -> str:
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
