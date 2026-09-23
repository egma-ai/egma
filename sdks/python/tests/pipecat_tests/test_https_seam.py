"""The SDK's side of the HTTPS seam, checked against the shared fixture.

``packages/simulation-contract/fixtures/seam/sdk-https-exchange.v1.json``
holds the routes, limits, timeouts and literal exchanges egma's server, its
simulator and this SDK agree on. First the double that stands in for
egma's server is checked against every exchange, so the pipeline tests that
use it are tested against the fixture too. Then the SDK's client is checked
to send the fixture's requests and to read the fixture's answers.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pipecat.frames.frames")

import json
from typing import Any

import aiohttp
import pytest
from support import PROJECT_KEY, compact, egma, fixture

from egma import otlp, seam
from egma.pipecat import https_seam


def _request(fixture: dict[str, Any], name: str) -> dict[str, Any]:
    exchange = fixture["exchanges"][name]
    if "request_is" in exchange:
        return fixture["exchanges"][exchange["request_is"].split(".")[1]]["request"]
    return exchange["request"]


def _response(fixture: dict[str, Any], name: str) -> Any:
    exchange = fixture["exchanges"][name]
    if "response_is" in exchange:
        return fixture["not_a_simulation"]["body"]
    return exchange["response"]


def test_routes_limits_and_timeouts_are_the_fixtures(fixture):
    assert https_seam.HELLO_ROUTE == fixture["routes"]["hello"]
    assert https_seam.TOOL_ROUTE == fixture["routes"]["tool"]
    assert https_seam.CONFIRM_ROUTE == fixture["routes"]["confirm"]
    assert fixture["protocol_version"] == seam.PROTOCOL_VERSION

    limits = fixture["limits"]
    assert limits["largest_answer_bytes"] == seam.LARGEST_PAYLOAD_BYTES
    assert (
        limits["largest_hello_request_bytes"] == https_seam.LARGEST_HELLO_REQUEST_BYTES
    )
    assert limits["largest_tool_request_bytes"] == https_seam.LARGEST_TOOL_REQUEST_BYTES
    assert https_seam.LARGEST_REPLY_BYTES >= limits["largest_answer_bytes"]

    seconds = fixture["timeouts_seconds"]
    assert seconds["hello_attempt"] == https_seam.HELLO_ATTEMPT_SECONDS
    assert seconds["hello_attempts"] == https_seam.HELLO_ATTEMPTS
    assert seconds["hello_all_attempts"] == https_seam.HELLO_ALL_ATTEMPTS_SECONDS
    assert seconds["tool_attempt"] == https_seam.TOOL_ATTEMPT_SECONDS
    assert seconds["confirm_attempt"] == https_seam.CONFIRM_ATTEMPT_SECONDS
    assert (
        sum(https_seam.HELLO_RETRY_PAUSES_SECONDS)
        + seconds["hello_attempt"] * seconds["hello_attempts"]
        >= seconds["hello_all_attempts"]
    ), "the attempts and pauses must be able to use the whole allowance"


def test_the_refusal_words_and_codes_are_the_fixtures(fixture):
    by_code = {refusal["code"]: refusal["error"] for refusal in fixture["refusals"]}
    assert by_code[seam.MALFORMED_REQUEST] == "seam_refused"
    assert by_code[seam.UNKNOWN_TOOL] == "seam_refused"
    assert by_code[seam.ANSWER_TOO_LARGE] == "seam_refused"
    assert by_code[seam.UNSUPPORTED_PROTOCOL_VERSION] == "seam_refused"
    assert by_code[seam.FLOWS_FUNCTION_MOCKED] == "flows_function_mocked"
    assert fixture["not_a_simulation"]["status"] == 404
    assert fixture["not_a_simulation"]["body"]["error"] == https_seam.NOT_A_SIMULATION


@pytest.mark.parametrize(
    "name",
    [
        "hello",
        "hello_repeated",
        "hello_flows_mocked",
        "hello_wrong_version",
        "hello_malformed",
        "hello_not_a_simulation",
        "tool_answer",
        "tool_error",
        "tool_without_arguments",
        "tool_unknown",
        "tool_flows_mocked",
        "tool_not_a_simulation",
        "confirm_live",
        "confirm_not_a_simulation",
        "unauthenticated",
    ],
)
async def test_the_double_answers_every_exchange_as_the_fixture_says(
    fixture, egma, name
):
    exchange = fixture["exchanges"][name]
    route = fixture["routes"][exchange["route"]]
    headers = {"Content-Type": "application/json"}
    if not exchange.get("without_authorization"):
        headers["Authorization"] = f"Bearer {PROJECT_KEY}"
    async with aiohttp.ClientSession() as client:
        async with client.post(
            f"{egma.url}{route}", data=compact(_request(fixture, name)), headers=headers
        ) as response:
            status = response.status
            body = await response.read()
    assert status == exchange["status"]
    assert json.loads(body) == _response(fixture, name)
    if "bytes" in exchange:
        assert body.decode() == exchange["bytes"]
    if "records" in exchange:
        reference = _request(fixture, name)["provider_reference"]
        recorded = egma.reports[reference]
        assert {key: recorded[key] for key in exchange["records"]} == exchange[
            "records"
        ]


def _client(egma, fixture, world: str = "calendar", reference: str | None = None):
    return https_seam.Seam(
        otlp.api_root(egma.url, "test"),
        PROJECT_KEY,
        reference or fixture["worlds"][world]["simulation_id"],
    )


async def test_the_hello_sends_the_fixtures_request_and_reads_its_reply(fixture, egma):
    request = _request(fixture, "hello")
    client = _client(egma, fixture)
    try:
        mocked = await client.hello(request["tools"])
    finally:
        await client.close()

    assert mocked == tuple(fixture["exchanges"]["hello"]["response"]["mocked_tools"])
    assert egma.bodies("hello") == [request]
    assert egma.asked[0].authorization == f"Bearer {PROJECT_KEY}"


async def test_a_mocked_flows_function_at_hello_is_refused_in_egmas_words(
    fixture, egma
):
    request = _request(fixture, "hello_flows_mocked")
    client = _client(egma, fixture, "flows")
    try:
        with pytest.raises(https_seam.HelloFailed) as failed:
            await client.hello(request["tools"])
    finally:
        await client.close()

    assert egma.bodies("hello") == [request]
    assert failed.value.verbatim is True
    assert (
        failed.value.reason
        == fixture["exchanges"]["hello_flows_mocked"]["response"]["message"]
    )


async def test_not_a_simulation_is_its_own_answer(fixture, egma):
    request = _request(fixture, "hello_not_a_simulation")
    client = _client(egma, fixture, reference=request["provider_reference"])
    try:
        with pytest.raises(https_seam.NotASimulation):
            await client.hello(request["tools"])
    finally:
        await client.close()
    assert egma.bodies("hello") == [request]


async def test_another_404_is_a_failure_never_inertness(egma, fixture):
    client = https_seam.Seam(
        f"{egma.url}/somewhere-else", PROJECT_KEY, "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"
    )
    try:
        with pytest.raises(https_seam.HelloFailed) as failed:
            await client.hello([])
    finally:
        await client.close()
    assert "HTTP 404" in failed.value.reason


async def test_a_wrong_key_is_named_in_the_failure(egma, fixture):
    client = https_seam.Seam(
        otlp.api_root(egma.url, "test"),
        f"egma_sk_{'x' * 43}",
        fixture["worlds"]["calendar"]["simulation_id"],
    )
    try:
        with pytest.raises(https_seam.HelloFailed) as failed:
            await client.hello([])
    finally:
        await client.close()
    message = fixture["exchanges"]["unauthenticated"]["response"]["message"]
    assert "HTTP 401" in failed.value.reason
    assert message in failed.value.reason


@pytest.mark.parametrize(
    ("name", "world", "flows", "outcome"),
    [
        (
            "tool_answer",
            "calendar",
            False,
            seam.Served(failed=False, value={"slots": []}),
        ),
        (
            "tool_error",
            "calendar",
            False,
            seam.Served(failed=True, message="the calendar service is unavailable"),
        ),
        (
            "tool_without_arguments",
            "calendar",
            False,
            seam.Served(failed=False, value={"slots": []}),
        ),
    ],
)
async def test_a_tool_call_sends_the_fixtures_request_and_reads_the_tag(
    fixture, egma, name, world, flows, outcome
):
    request = _request(fixture, name)
    client = _client(egma, fixture, world)
    try:
        served = await client.tool(
            request["name"], request.get("arguments"), flows=flows
        )
    finally:
        await client.close()
    assert egma.bodies("tool") == [request]
    assert served == outcome


@pytest.mark.parametrize(
    ("name", "world", "flows"),
    [
        ("tool_unknown", "calendar", False),
        ("tool_flows_mocked", "flows", True),
    ],
)
async def test_a_refused_tool_call_is_an_error_that_names_egmas_sentence(
    fixture, egma, name, world, flows
):
    request = _request(fixture, name)
    client = _client(egma, fixture, world)
    try:
        served = await client.tool(
            request["name"], request.get("arguments"), flows=flows
        )
    finally:
        await client.close()
    assert egma.bodies("tool") == [request]
    sentence = fixture["exchanges"][name]["response"]["message"]
    assert served.failed is True
    assert served.message == (
        f'Egma could not answer the mocked tool "{request["name"]}": '
        f"{sentence.rstrip('.')}. The real tool did not run."
    )
    assert ".." not in served.message


async def test_confirm_reads_only_a_live_simulation_as_confirmed(fixture, egma):
    live = _request(fixture, "confirm_live")
    gone = _request(fixture, "confirm_not_a_simulation")
    confirming = _client(egma, fixture, reference=live["provider_reference"])
    refusing = _client(egma, fixture, reference=gone["provider_reference"])
    try:
        assert await confirming.confirm() is True
        assert await refusing.confirm() is False
    finally:
        await confirming.close()
        await refusing.close()
    assert egma.bodies("confirm") == [live, gone]


@pytest.mark.parametrize(
    ("setting", "base"),
    [
        ("https://api.egma.ai", "https://api.egma.ai"),
        ("https://api.egma.ai/", "https://api.egma.ai"),
        ("https://api.egma.ai/v1/traces", "https://api.egma.ai"),
        ("https://egma.example/api/v1/traces/", "https://egma.example/api"),
        ("http://127.0.0.1:3100", "http://127.0.0.1:3100"),
    ],
)
def test_the_sdk_routes_and_the_trace_door_share_one_root(setting, base):
    assert otlp.api_root(setting, "test") == base
    assert otlp.trace_endpoint(setting, "test") == f"{base}/v1/traces"


@pytest.mark.parametrize(
    "setting", ["ftp://api.egma.ai", "https://user:pw@api.egma.ai", "https://a.b/?q=1"]
)
def test_a_bad_egma_url_is_refused(setting):
    with pytest.raises(ValueError, match="EGMA_URL"):
        otlp.api_root(setting, "test")


@pytest.mark.parametrize(
    ("failure", "attempts"),
    [
        pytest.param(TimeoutError(), 3, id="a timeout is asked again"),
        pytest.param(
            aiohttp.ClientConnectionError("refused"), 3, id="a connection error too"
        ),
        pytest.param(
            aiohttp.ClientPayloadError("cut short"), 1, id="an unreadable answer is not"
        ),
    ],
)
async def test_the_hello_asks_again_only_when_egma_was_not_reached(
    monkeypatch, failure, attempts
):
    monkeypatch.setattr(https_seam, "HELLO_RETRY_PAUSES_SECONDS", (0.01, 0.01))
    asked: list[str] = []

    async def failing(self, route, payload, seconds):
        asked.append(route)
        raise failure

    monkeypatch.setattr(https_seam.Seam, "_post", failing)
    client = https_seam.Seam("https://app.egma.ai", PROJECT_KEY, "sim_x")

    with pytest.raises(https_seam.HelloFailed):
        await client.hello([])

    assert len(asked) == attempts


@pytest.mark.parametrize(
    ("status", "attempts"),
    [(429, 3), (502, 3), (503, 3), (504, 3), (500, 1), (401, 1), (422, 1)],
)
async def test_the_hello_asks_again_only_for_the_busy_statuses(egma, status, attempts):
    egma.hello_statuses = [status] * 3
    client = https_seam.Seam(
        otlp.api_root(egma.url, "test"), PROJECT_KEY, "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"
    )
    try:
        with pytest.raises(https_seam.HelloFailed):
            await client.hello([])
    finally:
        await client.close()

    assert egma.routes_asked() == ["hello"] * attempts
