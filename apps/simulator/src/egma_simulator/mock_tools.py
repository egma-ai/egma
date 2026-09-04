"""Mock tools: egma answering for the agent's own tools, at the seam.

A **mock tool** answers for one of the agent's tools while a simulation
runs, so the agent's real backend is never touched and a test can order up
the branch it needs — an empty calendar, a booking that errors, a lookup
that finds nobody. Which tools this simulation answers for, and what each
answers with, arrives on the claimed spec already resolved from the test
that named them: nothing here to merge and nothing to disagree about.

## The exchange

egma is already a participant in the room. So the agent's side asks egma,
in the room, before anything real runs — two methods and no more:

- **``egma.hello``** — sent when the agent's session starts and again when a
  LiveKit handoff discovers more tools. It carries the protocol version and
  the cumulative census: every tool found in the session so far, by name,
  with its schema. egma replaces the stored census and answers with the fixed
  names it will answer for, so the other side wraps exactly those and leaves
  every other tool alone.
- **``egma.tool``** — one per call the agent makes to a wrapped tool. It
  carries the tool's name and the arguments. egma answers at once with the
  pinned answer and writes the whole exchange down: what was asked, what
  was served, and how long it took.

Both directions are JSON objects in a string, because that is what the
transport carries, and the answer travels on the wire in **the shape it
was authored in** — ``{"answer": …}`` or ``{"error": …}`` — from the
authoring row, through the run's snapshot, through the claimed spec, onto
the wire. One shape all that way means nothing in between re-tags it, and
the tag is what lets the other side tell "return this" from "raise this"
even when the authored value itself looks like a failure.

## Nothing here knows about LiveKit

The two handlers take a payload string and answer with one; a refusal is
:class:`MockToolRefusal`, which whoever registered them turns into their
transport's own error. That is what keeps the exchange — report the call,
receive an answer — a contract rather than a room feature, and it is why
the room driver can register these against a real LiveKit and against the
room-shaped stand-in CI runs, with nothing here changing.

## The other way egma stands in the tool path

Some platforms serve egma's answers themselves: the answers ride the
request, the platform matches them by name, and it reports afterwards
which tools were called and what each was given. Egma is just as much in
the tool path there — the agent's real backend was never reached — but
there is no exchange to conduct, so :meth:`MockToolSeam.hello` and
:meth:`MockToolSeam.tool` have nothing to do.

That lane uses these other doors: :meth:`MockToolSeam.answers` for the
answers to send, :meth:`MockToolSeam.handed_over` to say they are in the
platform's hands, and :meth:`MockToolSeam.reported` for each call the
platform tells egma about afterwards. The answers are rendered here, once,
so the bytes a tool is given are the same bytes on every lane and one
record reads across them.

## What lands on the record

Every call egma answers becomes a ``tool_call`` span: the name, the
arguments as they arrived, what the call was given, the provenance stamp,
and the mock tool that answered. The span brackets the exchange — the
round trip, from the call arriving to the answer going back — so the time
it really took is the span's own duration, with no second field to
disagree with it.

A call served for a tool the census never named is flagged
**late-attached**: answers stand ready for every name this simulation
covers whether or not the census mentioned it, which is the safe way
round, and the flag carries the caveat that such a call's arguments may
be thin.

A call for a name **outside** this simulation's answers is refused, on
the wire and on the record. It is a protocol error — the other side was
told exactly which names egma answers for — and quietly letting it
through would put a call egma never answered on the record as one it did.
Its span carries the provenance ``refused``: no result and no mock tool,
because nothing answered it, but a stamp all the same. A span with no
stamp means egma watched the call go past to a real backend, and a
refused call is the opposite of that.
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
"""Which version of this exchange egma's participant speaks.

It rides every hello in both directions, so a mismatch is refused at the
first message rather than discovered halfway through a simulation. That
is the whole of where it travels: this number is a property of the
exchange, and nothing about how either side found the other. An SDK
speaking 1 and a simulator speaking 1 therefore understand each other
whichever way round they were upgraded.

Two facts constrain a future bump, and both are load-bearing. This file
and the SDK's own copy are deliberately duplicated and must stay equal,
and
``packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json``
pins the number into the canonical bytes both suites read. So a real
shape change ships in this order: the simulator first accepts both
versions in :func:`_speaks_this_version`, a second fixture is added
beside the first rather than edited into it, and only once that release
has drained may the SDK start sending the new number. Self-hosting makes
"old simulator, new SDK" a lasting pairing rather than a rollout window,
which is why the order is that way round.
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
failed.

Authoring refuses an answer this large, counting the same bytes this does:
the tagged message, ``{"answer": …}`` or ``{"error": …}``, serialized the
way :func:`_serialized` serializes it. So a mock tool that was accepted can
always be served, and reaching the refusal below means a cap moved
somewhere. It is checked anyway, because the alternative is finding out
during somebody's simulation.
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
class ExchangedToolCall:
    """One call that reached egma, and what egma did with it.

    Both ends are instants on the wall clock: an exchange egma conducted
    is timed by egma, unlike a turn, which is read off the audio. The span
    it becomes brackets exactly this — the round trip.
    """

    name: str
    """The tool's name, exactly as the call reported it."""

    arguments: str | None
    """The arguments as JSON, or ``None`` where the call carried none."""

    answer: str | None
    """What the call was given, JSON-encoded: the tool's own return value,
    or the tagged failure where the mock tool answered with one — a
    failure has no return value, and a record that could not tell the two
    apart would read a mocked failure as a tool that returned a string.
    ``None`` for a call egma refused, which is a call nobody was answered
    about at all."""

    mock_tool: str | None
    """The mock tool that answered, by name. ``None`` exactly where
    :attr:`answer` is: a result is never recorded without the stamp that
    says where it came from."""

    late_attached: bool
    """True where the census never named this tool. Absent from the record
    otherwise: a stamp for the ordinary case would ride every span."""

    refused: bool
    """True where egma was asked and said no — a call for a name outside
    this simulation's answers.

    Its own fact on the record, because the alternative reading is the
    opposite one. A call carrying no stamp at all means egma watched it go
    past to a real backend; a refused call never reached a backend at all.
    Told apart here so a reader is never left to guess which happened."""

    began_unix_nano: int
    ended_unix_nano: int


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
    ) -> None:
        self._answers = {mock.tool_name: mock for mock in mock_tools}
        self._clock = clock
        self._censuses = 0
        self._discovered: tuple[str, ...] = ()
        self._exchanged: list[ExchangedToolCall] = []

    # -- What the driver does with it -----------------------------------------

    def standing_ready(self) -> None:
        """The handlers are in front of the agent; egma is in the tool path.

        Said by whoever registered them. The seam keeps no tally of it: a
        call egma answered is on the record as one it answered, and a room
        nobody joined leaves no such call to read.
        """

    def exchanged(self) -> list[ExchangedToolCall]:
        """Every call since this was last asked, and then none.

        Drained rather than accumulated, so whoever authors spans from
        them can ask as often as it likes and no call is ever written
        down twice.
        """
        taken, self._exchanged = self._exchanged, []
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

    def handed_over(self) -> None:
        """The answers are in the platform's own hands for this exchange.

        The same claim :meth:`standing_ready` makes, on the lane where the
        handing over *is* egma coming to stand between the agent and its
        backends: there is no census to answer and no call to serve, and
        every name this simulation answers for will be answered by the
        platform from here on.
        """

    def reported(self, name: str, *, arguments: str | None = None) -> None:
        """One tool call the platform says it made.

        Written down the way a call egma served itself is, with two
        differences that are both the truth about this lane. It is one
        instant, because egma did not conduct the exchange and did not time
        it. And the result rides **only** where this simulation has an
        answer for the name: such a call was answered from egma's own
        authored answer, so recording that answer invents nothing, while
        a call for any other name ran the customer's real implementation
        and its return value is neither egma's to vouch for nor the
        record's to stamp. That one lands as the observation it is — the
        name, the arguments, and no stamp at all, which is the record's own
        way of saying a real backend did the work.

        The answer recorded for a covered call is **egma's own rendering**
        and never the platform's echo of it, even where the platform
        reports one. The two are the same value, and only egma's carries
        the tag that tells a mocked failure from a tool that returned a
        string — the platform says that part in its own field, which the
        record has no room for.

        Never *refused*: nothing here was asked of egma, so there was
        nothing for egma to say no to.
        """
        called = name.strip()
        if not called:
            raise ValueError("a tool call the platform reported must name a tool")
        now = self._clock()
        if called not in self._discovered:
            self._discovered = (*self._discovered, called)
        mock = self._answers.get(called)
        self._write_down(
            ExchangedToolCall(
                name=called,
                arguments=arguments,
                answer=None if mock is None else _recorded(mock),
                mock_tool=None if mock is None else mock.tool_name,
                late_attached=False,
                refused=False,
                began_unix_nano=now,
                ended_unix_nano=now,
            )
        )

    # -- The two methods ------------------------------------------------------

    async def hello(self, payload: str) -> str:
        """The census in, the names egma answers for out.

        A second hello replaces the first rather than adding to it: the
        census is a snapshot of the agent's tools, and an agent that
        re-announces itself is announcing what it has *now*.
        """
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
        # Measured before anything here is written down: a reply that
        # cannot be sent tells the other side nothing, so it wraps nothing,
        # and a census recorded ahead of the refusal would leave the record
        # claiming egma was asked and answered. A test naming more mocked
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
            # only the last one is kept, and an operator reading a
            # late-attached call that surprises them deserves to find the
            # moment the census changed.
            logger.info(
                "a second census replaced the first: %d tool(s) became %d",
                len(replacing),
                len(self._discovered),
            )
        return reply

    async def tool(self, payload: str) -> str:
        """One tool call: answered at once, and written down."""
        began = self._clock()
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
        written = None if arguments is None else _serialized(arguments)

        mock = self._answers.get(name)
        if mock is None:
            # Never a pass-through — and the record says so out loud. The
            # other side was told which names egma answers for, so a call
            # for any other name is that side asking for something it was
            # never offered; answering it anyway, or waving it through,
            # would put a tool egma had no answer for on the record as one
            # it served. Written down as *refused* rather than as a bare
            # observation, because a bare observation is the record's way
            # of saying the real tool ran with egma nowhere near it, and
            # here the opposite happened.
            self._write_down(
                ExchangedToolCall(
                    name=name,
                    arguments=written,
                    answer=None,
                    mock_tool=None,
                    late_attached=False,
                    refused=True,
                    began_unix_nano=began,
                    ended_unix_nano=self._clock(),
                )
            )
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

        # Two shapes, and the difference is the whole of why the answer is
        # tagged. The **wire** carries the tag, because the other side has
        # to know whether to return this to the model or raise it, and an
        # authored value that happened to look like a failure would
        # otherwise be one. The **record** carries what the call was given
        # — the tool's own return value, untagged, because that is what
        # the agent received and what a grader reads. A failure has no
        # return value to record, so there the tag stays: it is what keeps
        # a mocked failure from reading as a tool that returned a string.
        served = _serialized(mock.answer)
        _fits_on_the_wire(f"the mock tool for {name!r}", served)
        recorded = _recorded(mock)

        self._write_down(
            ExchangedToolCall(
                name=name,
                arguments=written,
                answer=recorded,
                mock_tool=mock.tool_name,
                late_attached=name not in self._discovered,
                refused=False,
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
    """What the record carries for a call one mock tool answered.

    The **wire** carries the tag — ``{"answer": …}`` or ``{"error": …}`` —
    because whoever serves the answer has to know whether to return it to
    the model or raise it, and an authored value that happened to look
    like a failure would otherwise be one. The **record** carries what the
    call was given: the tool's own return value, untagged, because that is
    what the agent received and what a grader reads. A failure has no
    return value to record, so there the tag stays — it is what keeps a
    mocked failure from reading as a tool that returned a string.

    Known and accepted: a tool whose own return value is an object with an
    ``error`` key records the same bytes a mocked failure does. The
    record's vocabulary gives the branch no slot of its own, and inventing
    one here would be this file deciding what the contract says.
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
