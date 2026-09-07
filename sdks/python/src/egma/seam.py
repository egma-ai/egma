"""Transport-independent JSON contract for mock-tool RPC.

``egma.hello`` sends cumulative tool names and schemas at startup and
handoffs; its reply names the tools Egma will answer. ``egma.tool``
sends a tool name and arguments, receiving ``{"answer": ...}`` or
``{"error": ...}``. Read the tag; never infer failure from the value.

The SDK and simulator define their constants independently so the
published SDK has no service dependency. Both test the wire version,
methods, refusal codes, limits, and messages against
``packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
"""Wire version carried in both hello messages and checked by mocked_tools_in.

Bump when message shapes change. Before an SDK sends a new version, deploy
a simulator release that accepts both versions and retire incompatible instances.
"""

HELLO_METHOD = "egma.hello"
"""Where a session announces itself and learns what egma answers for."""

TOOL_METHOD = "egma.tool"
"""Where one tool call is asked and answered."""

LARGEST_PAYLOAD_BYTES = 15 * 1024
"""Maximum UTF-8 payload size accepted by the RPC transport. Check requests before
sending.
"""

LONGEST_DECLARED_DELAY_SECONDS = 30.0
"""Version 1 delay allowance retained in the RPC timeout calculation.
The current mock-tool authoring model has no delay setting.
"""

SERVING_MARGIN_SECONDS = 5.0
"""Processing allowance included in RPC timeouts, in seconds."""

MAX_ROUND_TRIP_SECONDS = 10.0
"""Request and acknowledgement allowance, in seconds."""

RESPONSE_TIMEOUT_SECONDS = (
    LONGEST_DECLARED_DELAY_SECONDS + SERVING_MARGIN_SECONDS + MAX_ROUND_TRIP_SECONDS
)
"""Explicit tool RPC timeout: the version 1 allowance plus processing and transport
margins.
"""

HELLO_TIMEOUT_SECONDS = MAX_ROUND_TRIP_SECONDS + SERVING_MARGIN_SECONDS
"""Hello RPC timeout, shorter than the tool timeout.
Hello runs before AgentSession.start; a stalled exchange must leave time
for the agent to join and publish audio within the simulator startup limit.
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
"""Egma application refusal codes, separate from LiveKit transport codes 1001–1999."""

EGMA_NOT_REACHED = frozenset({1400, 1401, 1403, 1404, 1503})
"""Transport codes for an unavailable recipient, method, server, or RPC version.
These codes do not permit fallback to the real tool during a simulation.
"""

EGMA_NOT_LISTENING_YET = frozenset({1400})
"""Retry an unsupported-method response while the hello startup budget remains.
The participant can arrive before its RPC methods are registered.
Once the budget expires, startup fails; the real tool is not a fallback.
"""


class SeamError(Exception):
    """The RPC reply cannot be read as a valid answer."""


@dataclass(frozen=True)
class Served:
    """Tagged mock-tool result. An answer can itself contain an error key,
    so the outer tag determines whether the call failed.
    """

    failed: bool
    """True where egma served a failure — the branch a test forces."""

    value: Any = None
    """Successful result when failed is false; None is a valid answer."""

    message: str = ""
    """The failure's words, where :attr:`failed` is true. They reach the
    model, so they are the mock tool author's sentence, not this side's."""


def hello_request(census: list[dict[str, Any]]) -> str:
    """The census, in the shape ``egma.hello`` carries it."""
    return _serialized({"protocol_version": PROTOCOL_VERSION, "tools": census})


def _is_this_version(declared: object) -> bool:
    """Accept the integer wire version, excluding booleans: Python treats True as 1."""
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
    """Serialize compact JSON, converting unsupported customer values to strings.

    Keep non-ASCII text unescaped. Message limits are measured in UTF-8
    bytes by both implementations.
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
