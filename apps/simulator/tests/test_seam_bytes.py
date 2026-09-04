"""egma's half of the mock-tool exchange, held to the contract's bytes.

The exchange has two halves written twice on purpose: this service's, and
the SDK a customer installs in their own agent. Neither imports the
other — a package inside somebody else's process must not drag egma's
dependencies in with it — so nothing but a test can keep the two speaking
the same language.

``packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json``
is that language written down: the version, the two method names, the
four refusal codes, both caps, and a canonical message for every shape
either side sends. This suite asserts egma's constants against it and
drives egma's own handlers with its exact bytes. The SDK's suite reads
the same file and asserts its own. A number or a shape that moves on one
side now fails a hermetic test on that side, with the file naming what it
was supposed to be.
"""

from __future__ import annotations

import json
from pathlib import Path

from egma_simulator.contract import contract_dir
from egma_simulator.mock_tools import (
    ANSWER_TOO_LARGE,
    HELLO_METHOD,
    LARGEST_PAYLOAD_BYTES,
    MALFORMED_REQUEST,
    PROTOCOL_VERSION,
    TOOL_METHOD,
    UNKNOWN_TOOL,
    UNSUPPORTED_PROTOCOL_VERSION,
    MockToolRefusal,
    MockToolSeam,
)
from egma_simulator.spec import MockTool


def seam_fixture() -> dict:
    path: Path = (
        contract_dir() / "fixtures" / "seam" / "mock-tool-exchange.v1.json"
    )
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


GOLDEN = seam_fixture()


def message(name: str) -> str:
    return GOLDEN["messages"][name]["bytes"]


def test_the_version_and_the_two_method_names_are_the_contracts():
    """Everything about this exchange starts with these three strings.

    A method name that moved would leave the two halves knocking on
    different doors, and a version that moved would have them refuse each
    other at the first message — which is the good outcome, and still one
    nobody should discover in a live simulation.
    """
    assert PROTOCOL_VERSION == GOLDEN["protocol_version"]
    assert HELLO_METHOD == GOLDEN["methods"]["hello"]
    assert TOOL_METHOD == GOLDEN["methods"]["tool"]


def test_the_refusal_codes_are_the_contracts():
    """The far side branches on these numbers, so they are the wire.

    Read as a whole map rather than one by one: a code quietly added on
    one side is drift as surely as a code that changed, and only the
    whole set says so.
    """
    assert {refusal["code"] for refusal in GOLDEN["refusals"]} == {
        MALFORMED_REQUEST,
        UNKNOWN_TOOL,
        ANSWER_TOO_LARGE,
        UNSUPPORTED_PROTOCOL_VERSION,
    }
    assert MALFORMED_REQUEST == 901
    assert UNKNOWN_TOOL == 902
    assert ANSWER_TOO_LARGE == 903
    assert UNSUPPORTED_PROTOCOL_VERSION == 904
    # egma's own block, clear of the transport's, so a code always says
    # whose complaint it is.
    assert GOLDEN["reserved_for_the_transport"]["from"] > UNSUPPORTED_PROTOCOL_VERSION


def test_the_payload_cap_is_the_contracts():
    """One number, three places: here, the SDK, and the authoring door
    that refuses an answer larger than this before a simulation ever
    starts. Two of the three would be a cap that admits what the third
    refuses."""
    assert LARGEST_PAYLOAD_BYTES == GOLDEN["limits"]["largest_payload_bytes"]


async def test_the_hello_reply_is_the_golden_bytes():
    """The census in, the names egma answers for out — byte for byte.

    The fixture's census names two tools and this simulation answers for
    one of them, which is the ordinary case and the one where the reply
    has something to leave out.
    """
    seam = MockToolSeam((MockTool("check_calendar", {"answer": {"slots": []}}),))

    assert await seam.hello(message("hello_request")) == message("hello_reply")


async def test_both_tool_replies_are_the_golden_bytes():
    """The two branches, tagged, exactly as the far side reads them.

    A mock tool's authored answer may itself be an object with an
    ``error`` key, so the far side reads the tag and never the shape —
    which only works if the tag is where this file says it is.
    """
    answering = MockToolSeam((MockTool("check_calendar", {"answer": {"slots": []}}),))
    assert await answering.tool(message("tool_request")) == message(
        "tool_reply_answer"
    )

    failing = MockToolSeam(
        (
            MockTool(
                "check_calendar",
                {"error": "the calendar service is unavailable"},
            ),
        )
    )
    assert await failing.tool(message("tool_request")) == message("tool_reply_error")


async def test_a_call_with_no_arguments_at_all_is_read_the_same_way():
    """The shape a tool attached after the census arrives in: no
    ``arguments`` key at all, because an empty object would say the call
    had none. egma answers it exactly as it answers a call that carried
    them."""
    seam = MockToolSeam((MockTool("check_calendar", {"answer": {"slots": []}}),))

    assert await seam.tool(message("tool_request_without_arguments")) == message(
        "tool_reply_answer"
    )


async def test_the_hello_reply_names_only_what_this_simulation_answers_for():
    """The census's second tool is absent from the reply, and a call to
    it is refused with the code the fixture names — which is the sentence
    the whole exchange rests on: the far side wraps exactly what egma
    said, so anything else is a protocol error."""
    seam = MockToolSeam((MockTool("check_calendar", {"answer": {"slots": []}}),))
    await seam.hello(message("hello_request"))

    census = json.loads(message("hello_request"))["tools"]
    assert [tool["name"] for tool in census] == ["check_calendar", "charge_card"]
    assert json.loads(message("hello_reply"))["mocked_tools"] == ["check_calendar"]

    try:
        await seam.tool('{"name":"charge_card","arguments":{"amount_cents":4200}}')
    except MockToolRefusal as refusal:
        assert refusal.code == UNKNOWN_TOOL
    else:  # pragma: no cover - the refusal is the test
        raise AssertionError("a call outside the answers was not refused")
