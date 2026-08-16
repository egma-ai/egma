"""This SDK's half of the mock-tool exchange, held to the contract's bytes.

``seam.py`` says the two halves of this exchange are held together by
tests against the bytes rather than by an import. This is that test.

The bytes are
``packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json``:
the protocol version, both method names, the four refusal codes, both
caps, and a canonical message for every shape either side sends. egma's
own simulator suite reads the same file and asserts its own constants and
handlers against it. So a version, a method name, a code, a shape or a
cap that moves on one side fails a hermetic test on that side — which is
the only kind of agreement two processes in two repositories, and one day
two languages, can actually keep.

Nothing here touches LiveKit, a room, or a network. It builds strings and
reads strings, which is all this half of the seam ever does.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from egma import seam


def _contract_dir() -> Path:
    """Where the contract package lives, from anywhere in the checkout."""
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "packages" / "simulation-contract"
        if (candidate / "fixtures").is_dir():
            return candidate
    raise FileNotFoundError(
        "packages/simulation-contract not found above "
        f"{Path(__file__).resolve()}; this suite is run from the checkout"
    )


def _golden() -> dict:
    path = _contract_dir() / "fixtures" / "seam" / "mock-tool-exchange.v1.json"
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


GOLDEN = _golden()


def message(name: str) -> str:
    return GOLDEN["messages"][name]["bytes"]


def test_the_version_and_the_two_method_names_are_the_contracts():
    """The three strings the whole exchange starts from. A method name
    that moved here would leave this side knocking on a door egma does
    not answer, and nothing about that failure would say why."""
    assert seam.PROTOCOL_VERSION == GOLDEN["protocol_version"]
    assert seam.HELLO_METHOD == GOLDEN["methods"]["hello"]
    assert seam.TOOL_METHOD == GOLDEN["methods"]["tool"]


def test_the_refusal_codes_are_the_contracts():
    """This side branches on these numbers to decide whether the real
    tool runs, so they are load-bearing rather than informational."""
    assert {refusal["code"] for refusal in GOLDEN["refusals"]} == {
        seam.MALFORMED_REQUEST,
        seam.UNKNOWN_TOOL,
        seam.ANSWER_TOO_LARGE,
        seam.UNSUPPORTED_PROTOCOL_VERSION,
    }
    # egma's block and the transport's cannot overlap, which is what lets a
    # code say whose complaint it is — and this side reads that distinction
    # to decide whether being refused means the real tool may run.
    reserved = GOLDEN["reserved_for_the_transport"]
    assert seam.EGMA_REFUSALS.stop <= reserved["from"]
    for refusal in GOLDEN["refusals"]:
        assert refusal["code"] in seam.EGMA_REFUSALS
    for code in seam.EGMA_NOT_REACHED:
        assert reserved["from"] <= code <= reserved["to"]


def test_both_caps_are_the_contracts():
    """The payload cap this side names, and the delay cap the timeout
    below is derived from. Both are egma's numbers; both are restated
    here because this package cannot import them."""
    assert seam.LARGEST_PAYLOAD_BYTES == GOLDEN["limits"]["largest_payload_bytes"]
    assert (
        seam.LONGEST_DECLARED_DELAY_SECONDS * 1000
        == GOLDEN["limits"]["longest_delay_milliseconds"]
    )


def test_the_wait_is_the_arithmetic_it_claims_against_the_real_cap():
    """30 s of legal delay, 5 s of serving, 10 s of round trip.

    The delay comes from the contract rather than from a number restated
    here, which is the whole difference: an arithmetic checked against
    its own copy of the input cannot notice the input moving. Raise the
    cap egma admits and this fails until the timeout is raised with it,
    which is the only thing standing between a legal 30-second delay and
    a call this side gives up on.
    """
    largest_delay = GOLDEN["limits"]["longest_delay_milliseconds"] / 1000
    assert (
        largest_delay + seam.SERVING_MARGIN_SECONDS + seam.MAX_ROUND_TRIP_SECONDS
        == seam.RESPONSE_TIMEOUT_SECONDS
    )
    # And the wait really does outlast the longest delay somebody may author,
    # which is the property the sum exists to hold.
    assert seam.RESPONSE_TIMEOUT_SECONDS > largest_delay


def test_the_census_this_side_builds_is_the_golden_bytes():
    """The first message of every simulation, byte for byte.

    The census is taken from the fixture and handed back to the builder,
    so what is compared is this side's own envelope — the version key,
    the tools key, the ordering, the separators — and not the tools.
    """
    census = json.loads(message("hello_request"))["tools"]

    assert seam.hello_request(census) == message("hello_request")


def test_the_names_egma_answers_for_are_read_off_the_golden_reply():
    """The reply decides which tools get a courier. A shape misread here
    is an agent that either wraps nothing or wraps something egma will
    refuse."""
    assert seam.mocked_tools_in(message("hello_reply")) == ("check_calendar",)


def test_both_call_shapes_this_side_builds_are_the_golden_bytes():
    """One call with arguments, and one from a tool attached after the
    census, whose courier has no signature to read them through — where
    the key is left off entirely rather than sent as an empty object."""
    asked = json.loads(message("tool_request"))

    assert seam.tool_request(asked["name"], asked["arguments"]) == message(
        "tool_request"
    )
    assert seam.tool_request(asked["name"], None) == message(
        "tool_request_without_arguments"
    )


def test_both_answers_are_read_off_the_tag_and_never_the_shape():
    """The two branches the far side sends, read the way this side reads
    them: off the tag. An authored value that itself looks like a failure
    is still a success, which is exactly what reading the shape would get
    wrong."""
    served = seam.served_in(message("tool_reply_answer"))
    assert served.failed is False
    assert served.value == {"slots": []}

    failed = seam.served_in(message("tool_reply_error"))
    assert failed.failed is True
    assert failed.message == "the calendar service is unavailable"


def test_a_reply_wearing_neither_tag_is_refused_rather_than_guessed_past():
    """Handing the model an answer nobody served is the one thing a
    mocked call must never do, so an unreadable reply raises here rather
    than defaulting to anything."""
    with pytest.raises(seam.SeamError):
        seam.served_in('{"slots":[]}')
