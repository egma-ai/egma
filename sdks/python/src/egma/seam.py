"""The exchange, in bytes: what this side says and how it reads a reply.

Two methods and no more. **``egma.hello``** is sent when the session starts
and again when a LiveKit handoff discovers more tools. Each message carries
the cumulative census — every tool found in the session so far, by name,
with its schema. egma replaces the stored census and answers with the fixed
names it will answer for, so this side stands couriers in front of exactly
those and leaves every other tool alone. **``egma.tool``** carries one call:
the tool's name and the arguments. egma answers with what the mock tool holds.

Both directions are JSON objects in a string, because that is what the
transport carries, and an answer arrives **tagged** — ``{"answer": …}``
or ``{"error": …}``. The tag is the whole point: it is what lets this
side tell "return this to the model" from "raise this at the model" even
when the authored value itself looks like a failure. Nothing here guesses
from the shape of a value; it reads the tag.

## Nothing here knows about LiveKit

This module builds a request string and reads a reply string. It never
imports the transport, never raises the transport's errors, and never
learns a participant's name. That is what lets the whole exchange be
proved against a room-shaped stand-in with no LiveKit anywhere, and it is
why the codes below are the only vocabulary shared with the far side.

## Written twice on purpose

egma's own side of this exchange says these same constants and reads
these same shapes, in its own copy, and the two are deliberately not
shared. This is the half a customer installs: a package that reached
back into egma's services for a constant would drag egma's own
dependencies into the customer's process and tie the version they run to
the version egma deploys. The exchange is a **contract**, so the two
halves are held together by tests against the bytes rather than by an
import — which is also the only thing that would still work the day one
half is written in another language.

Those bytes are
``packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json``:
the version, both method names, the four refusal codes, both caps, and a
canonical message for every shape either side sends. This package's suite
and egma's own each read that one file, so a constant or a shape that
moves here fails a test here, and one that moves over there fails a test
over there — with the file naming what it was supposed to be.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
"""Which version of this exchange this side speaks.

It rides every hello in both directions, and the hello is the only place
it rides. One announcement, read where the exchange itself begins, is the
only reading that stays true when the two halves are deployed apart: a
number carried anywhere else would be a second answer to the same
question, and the second answer is the one that goes stale.
:func:`mocked_tools_in` is where a reply's number is held to this one.

The number moving is a decision this file records rather than a detail.
It moves when the *bytes* of these messages move, and not otherwise: a
version raised without a change to the shapes would refuse an egma that
can read every message this side sends, which is the whole of what a
self-hoster runs. When a real change does arrive, egma's own half must
first ship a release that accepts both numbers, and only after that
population has drained may this side start sending the new one.
"""

HELLO_METHOD = "egma.hello"
"""Where a session announces itself and learns what egma answers for."""

TOOL_METHOD = "egma.tool"
"""Where one tool call is asked and answered."""

LARGEST_PAYLOAD_BYTES = 15 * 1024
"""How much one message of this exchange may carry, in bytes of UTF-8.

The transport's own limit. An answer larger than this is refused when the
mock tool is authored, so the far side never sends one; this side names
the number because a census of a hundred tools is the one message *this*
side could grow past it.
"""

LONGEST_DECLARED_DELAY_SECONDS = 30.0
"""The longest delay a mock tool may declare, in seconds.

egma's authoring door refuses a larger one, and the claimed spec's own
schema refuses it again — this is that same ceiling, restated here
because the timeout below is derived from it and a derivation from a
number nobody wrote down is a number nobody can check. The seam fixture
is where the three are held to one value.
"""

SERVING_MARGIN_SECONDS = 5.0
"""What egma is allowed for serving the answer around the delay.

Reading the call, waiting the declared delay out, writing the exchange
down and answering. Small, and named rather than folded into the sum,
because a margin nobody can point at is a margin nobody can revise.
"""

MAX_ROUND_TRIP_SECONDS = 10.0
"""How long the request and its acknowledgement may take on the wire.

Written here rather than left alone because the transport's own default
is shorter, so a mock tool's declared delay could push a perfectly legal
answer past it and arrive as a call that mysteriously failed.
"""

RESPONSE_TIMEOUT_SECONDS = (
    LONGEST_DECLARED_DELAY_SECONDS + SERVING_MARGIN_SECONDS + MAX_ROUND_TRIP_SECONDS
)
"""How long a call to egma may take before this side stops waiting.

Added up rather than picked, and set explicitly on every call rather than
left to the transport's own default. 30 + 5 + 10 = 45. The arithmetic is
the reason the number is safe — a legal delay can never collide with a
timeout, so neither the transport nor the handling ever competes with a
delay somebody authored on purpose — and it is written as the sum rather
than as its answer so that raising the delay cap moves this with it
instead of silently leaving it behind.
"""

HELLO_TIMEOUT_SECONDS = MAX_ROUND_TRIP_SECONDS + SERVING_MARGIN_SECONDS
"""How long a hello may take before this side stops waiting. 10 + 5 = 15.

Shorter than the number above, and deliberately so. The sum above carries
``LONGEST_DECLARED_DELAY_SECONDS`` because a mock tool may legally hold an
answer back for that long; a hello has no authored delay to wait out, so
that term does not belong in it and carrying it anyway would let a stalled
hello hold the agent silent for 45 seconds.

That matters because of a bound on egma's own side: once egma is in the
room it gives an agent 30 seconds to join and publish audio, and a
simulation that runs out of them ends saying the agent never joined. A
hello is sent before ``AgentSession.start``, so every second spent here is
a second the agent is not speaking — and a timeout longer than egma's
would make egma's own record blame the customer's worker for a stall on
this side of the room.
"""

MALFORMED_REQUEST = 901
"""A message egma could not read at all."""

UNKNOWN_TOOL = 902
"""A call for a name this simulation has no answer for."""

ANSWER_TOO_LARGE = 903
"""An answer that would not fit on the wire."""

UNSUPPORTED_PROTOCOL_VERSION = 904
"""A hello in a version of this exchange egma does not speak."""

EGMA_REFUSALS = range(901, 1000)
"""The codes egma refuses in — 901 to 999, its own block.

Deliberately clear of 1001-1999, which the transport reserves for the
errors it raises itself. Two blocks that cannot collide means a code
always says whose complaint it is: an answer egma would not give, or a
message that never reached egma at all — and a log that guesses wrong
about which sends somebody to the wrong half of the system.
"""

EGMA_NOT_REACHED = frozenset({1400, 1401, 1403, 1404, 1503})
"""The transport's own way of saying nobody was there to ask.

``1401`` is the recipient that does not exist — every production room,
where there is no egma participant and never was. ``1503`` is the one
that left mid-simulation. ``1400``, ``1403`` and ``1404`` are the method,
the server and the version: a destination that cannot carry this exchange
at all. Every one of them means the message never reached an egma, so the
real tool runs and the agent behaves exactly as it would with no SDK
installed.

**Any other code means egma did answer, and an answer is never guessed
past** — being refused is not the same as not being heard, and running a
real backend on the back of a refusal would be this SDK deciding a
simulation may have side effects.

The wide set is the honest one on the census, where any of the five
means there is no exchange here to join. On a tool call only ``1401``
and ``1503`` are really reachable — a courier exists only because a
hello was already answered, so a destination that cannot carry the
exchange at all is behind us. The set is shared rather than split
because the reading is the same one, and a second constant for the
difference would be a distinction nothing can produce.
"""

EGMA_NOT_LISTENING_YET = frozenset({1400})
"""The one code that means "wait", rather than "there is nobody there".

``1400`` is the method the destination does not serve. egma's participant
is in the room before it registers the two methods of this exchange, and
on three of the four dispatch paths into an egma room the agent can
be asking inside that window — so this is the one refusal a census may be
sent again on, bounded, rather than fallen open on.

It is deliberately a subset of :data:`EGMA_NOT_REACHED` and not of its
own kind: once the waiting is over, ``1400`` still means egma was never
reached and the real tool still runs. The two readings do not compete,
because the first only applies while there is time left to ask again.
"""


class SeamError(Exception):
    """A reply this side cannot read as an answer.

    Raised rather than guessed past. The alternative — reading a reply
    that arrived in an unknown shape as some default — would hand the
    model an answer nobody served, which is the one thing a mocked call
    must never do.
    """


@dataclass(frozen=True)
class Served:
    """What egma answered one call with.

    Two shapes and a tag to tell them apart, because a mock tool's
    authored answer may itself be an object with an ``error`` key and
    reading the shape rather than the tag would turn that into a failure
    nobody authored.
    """

    failed: bool
    """True where egma served a failure — the branch a test forces."""

    value: Any = None
    """The value to hand back to the model, where :attr:`failed` is false.

    ``None`` is a legal answer, so this field is never what says whether
    the call succeeded.
    """

    message: str = ""
    """The failure's words, where :attr:`failed` is true. They reach the
    model, so they are the mock tool author's sentence, not this side's."""


def hello_request(census: list[dict[str, Any]]) -> str:
    """The census, in the shape ``egma.hello`` carries it."""
    return _serialized({"protocol_version": PROTOCOL_VERSION, "tools": census})


def _is_this_version(declared: object) -> bool:
    """Whether that is the version of the exchange this side speaks.

    Only the number itself will do, and a boolean is refused explicitly.
    Python counts ``True`` as equal to ``1``, so a reply whose
    ``protocol_version`` is JSON ``true`` would otherwise pass for version
    1 and this side would go on to speak an exchange nobody declared —
    standing couriers in front of an agent's tools on the word of a far
    side that never said which exchange it was answering in.
    """
    if isinstance(declared, bool) or not isinstance(declared, int):
        return False
    return declared == PROTOCOL_VERSION


def mocked_tools_in(reply: str) -> tuple[str, ...]:
    """The names egma will answer for, read off a hello's reply.

    Every one of them gets a courier, whether or not the agent has such a
    tool today: the far side binds by name at call time, so a tool
    attached after this is still intercepted, and a courier for a tool
    that never turns up simply never fires.
    """
    answered = _object(HELLO_METHOD, reply)
    version = answered.get("protocol_version")
    if not _is_this_version(version):
        raise SeamError(
            f"{HELLO_METHOD} was answered in protocol version {version!r}, and "
            f"this SDK speaks {PROTOCOL_VERSION}"
        )
    mocked = answered.get("mocked_tools")
    if not isinstance(mocked, list):
        raise SeamError(
            f"{HELLO_METHOD} answers with the tool names Egma covers, as a "
            f"list of strings, and this reply carried {_kind_of(mocked)}"
        )
    names: list[str] = []
    for name in mocked:
        if not isinstance(name, str) or not name.strip():
            raise SeamError(
                f"{HELLO_METHOD} answers with tool names, and one of them was "
                f"{_kind_of(name)}"
            )
        if name.strip() not in names:
            names.append(name.strip())
    return tuple(names)


def tool_request(name: str, arguments: dict[str, Any] | None) -> str:
    """One call, in the shape ``egma.tool`` carries it.

    ``arguments`` is left off entirely where this side could not see them
    — which is a tool attached after the census, whose courier has no
    signature to read them through. Sending an empty object instead would
    put "this call had no arguments" on the record, which is a different
    and untrue thing.
    """
    asking: dict[str, Any] = {"name": name}
    if arguments is not None:
        asking["arguments"] = arguments
    return _serialized(asking)


def served_in(reply: str) -> Served:
    """What one call was answered with, read off the tag.

    ``error`` is looked for first. egma sends exactly one tag, so a reply
    carrying both is already wrong — and of the two readings, the one
    that does *not* hand the model a success it may not have earned is
    the one to take.
    """
    answered = _object(TOOL_METHOD, reply)
    if "error" in answered:
        failure = answered["error"]
        if not isinstance(failure, str):
            raise SeamError(
                f"a {TOOL_METHOD} failure carries the mock tool's own "
                f"sentence, and this one carried {_kind_of(failure)}"
            )
        return Served(failed=True, message=failure)
    if "answer" in answered:
        return Served(failed=False, value=answered["answer"])
    raise SeamError(
        f"{TOOL_METHOD} answers with one tag — an answer to return or an "
        "error to raise — and this reply carried neither"
    )


def fits_on_the_wire(what: str, message: str) -> None:
    """Refuse a message the transport could not carry, before it is sent.

    Refused here rather than by the transport, because the transport's
    own complaint arrives as a call that mysteriously failed, where this
    one names the thing that outgrew the message.
    """
    bytes_over_the_wire = len(message.encode())
    if bytes_over_the_wire <= LARGEST_PAYLOAD_BYTES:
        return
    raise SeamError(
        f"{what} is {bytes_over_the_wire} bytes, and one message of this "
        f"exchange holds at most {LARGEST_PAYLOAD_BYTES}"
    )


def _object(method: str, payload: str) -> dict[str, Any]:
    """One reply, as the JSON object it has to be."""
    try:
        answered = json.loads(payload)
    except ValueError as unreadable:
        raise SeamError(
            f"{method} is answered with a JSON object, and this reply is not "
            f"JSON: {unreadable}"
        ) from unreadable
    if not isinstance(answered, dict):
        raise SeamError(
            f"{method} is answered with a JSON object, and this reply carried "
            f"{_kind_of(answered)}"
        )
    return answered


def _serialized(value: object) -> str:
    """One JSON document, in the compact shape the whole exchange uses.

    A value JSON has no word for is written as its text, rather than
    refusing the message. This side serialises the *customer's* data —
    an argument the model sent to a tool whose parameter is some type of
    their own — and a call that failed to go because one argument could
    not be described would be this SDK breaking a simulation over a thing
    it was only trying to write down. The framework itself takes the same
    way out when it canonicalises a call's arguments.

    Non-ASCII characters are written as themselves, not escaped: the cap
    above is counted in bytes of UTF-8, which is what the transport
    carries, and the other half of this exchange counts the same bytes.
    """
    return json.dumps(value, separators=(",", ":"), default=str, ensure_ascii=False)


def _kind_of(value: object) -> str:
    """What arrived, named by kind rather than quoted.

    A complaint says what shape it got, never the bytes it got: a reply
    holds the customer's own data and a message about it travels into
    logs.
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
