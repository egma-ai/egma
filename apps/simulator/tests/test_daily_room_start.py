"""The Pipecat start request: its bytes, its retries, and every refusal's words.

Requests go over real HTTP to a local scripted starter. The connector is the
only test substitution: the production one refuses loopback addresses, which
the address-policy tests below exercise on their own.
"""

from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import replace
from typing import Any

import pytest
from starter_stub import A_ROOM, Answer, starting

from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR, NOT_ANSWERED
from egma_simulator.media import MediaBackendError
from egma_simulator.media import daily_room as daily
from egma_simulator.media.daily_room import (
    DailyWayIn,
    PipecatStarter,
    StartSettings,
)
from egma_simulator.redaction import SecretRegistry

A_SIMULATION = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"
AN_AGENT = "lakeside-front-desk"
A_PUBLIC_KEY = "pk_SENTINEL0public0key0for0tests"
A_HEADER_SECRET = "Bearer SENTINEL-start-header-secret"
A_START_URL = "https://bots.lakeside-dental.example/start"


def local_socket(addr_info: tuple[Any, ...]) -> socket.socket:
    family, kind, protocol, _canonical_name, _sockaddr = addr_info
    return socket.socket(family=family, type=kind, proto=protocol)


class LocalStarter(PipecatStarter):
    """Reaches the local plaintext starter; the request code is production's."""

    def _endpoint_connector(self, aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
        connector = aiohttp.TCPConnector(
            resolver=resolver, socket_factory=local_socket, use_dns_cache=False
        )
        return resolver, connector


def cloud_settings() -> StartSettings:
    return StartSettings.from_connection(
        "daily_room.pipecat_cloud",
        {"agentName": AN_AGENT},
        {"publicApiKey": A_PUBLIC_KEY},
    )


def self_hosted_settings(start_url: str = A_START_URL) -> StartSettings:
    return StartSettings.from_connection(
        "daily_room.self_hosted",
        {"startUrl": start_url},
        {"headers": json.dumps({"Authorization": A_HEADER_SECRET})},
    )


def starter_for(
    settings: StartSettings,
    wire_url: str,
    *,
    body_params: dict[str, Any] | None = None,
    clock: float = 1_790_000_000.4,
) -> LocalStarter:
    return LocalStarter(
        replace(settings, start_url=wire_url),
        simulation_id=A_SIMULATION,
        body_params=body_params,
        max_duration_seconds=600,
        secrets=SecretRegistry(),
        wall_clock=lambda: clock,
    )


async def start(starter: PipecatStarter, *, window: float = 5.0) -> DailyWayIn:
    loop = asyncio.get_running_loop()
    return await starter.start(deadline=loop.time() + window)


def test_pipecat_cloud_starts_at_its_public_endpoint_with_the_public_key():
    settings = StartSettings.from_connection(
        "daily_room.pipecat_cloud",
        {"agentName": "front desk/2"},
        {"publicApiKey": A_PUBLIC_KEY},
    )
    assert settings.start_url == (
        "https://api.pipecat.daily.co/v1/public/front%20desk%2F2/start"
    )
    assert settings.headers == {"Authorization": f"Bearer {A_PUBLIC_KEY}"}
    assert A_PUBLIC_KEY in settings.secrets
    assert A_PUBLIC_KEY not in repr(settings)


async def test_a_pipecat_cloud_start_request_carries_the_room_expiry_and_merged_body():
    with starting(Answer(body={"dailyRoom": A_ROOM, "dailyToken": "tok"})) as served:
        starter = starter_for(
            cloud_settings(),
            served.wire_url,
            body_params={"tenant": "lakeside", "caller": {"plan": "gold"}},
        )
        way_in = await start(starter)

    assert way_in == DailyWayIn(room_url=A_ROOM, token="tok")
    (asked,) = served.asked
    assert asked.header("Authorization") == f"Bearer {A_PUBLIC_KEY}"
    assert asked.header("Content-Type") == "application/json"
    assert asked.body == {
        "createDailyRoom": True,
        "dailyRoomProperties": {
            "exp": 1_790_000_000 + 600 + 120,
            "eject_at_room_exp": True,
        },
        "body": {
            "tenant": "lakeside",
            "caller": {"plan": "gold"},
            "egma": {"simulation_id": A_SIMULATION, "modality": "voice"},
        },
    }
    assert list(asked.body["body"])[-1] == "egma"


async def test_a_self_hosted_start_request_adds_the_daily_transport_and_headers():
    with starting(Answer()) as served:
        starter = starter_for(self_hosted_settings(), served.wire_url)
        way_in = await start(starter)

    assert way_in.room_url == A_ROOM
    assert way_in.token is None
    (asked,) = served.asked
    assert asked.header("Authorization") == A_HEADER_SECRET
    assert asked.body["transport"] == "daily"
    assert asked.body["body"] == {
        "egma": {"simulation_id": A_SIMULATION, "modality": "voice"}
    }
    assert asked.body["createDailyRoom"] is True


async def test_capacity_refusals_are_retried_with_the_same_room_expiry():
    clock = iter([1_790_000_000.0, 1_790_000_050.0, 1_790_000_099.0])
    with starting(
        Answer(status=429, headers={"Retry-After": "0"}),
        Answer(status=429, headers={"Retry-After": "0"}),
        Answer(),
    ) as served:
        starter = LocalStarter(
            replace(cloud_settings(), start_url=served.wire_url),
            simulation_id=A_SIMULATION,
            body_params=None,
            max_duration_seconds=600,
            secrets=SecretRegistry(),
            wall_clock=lambda: next(clock),
        )
        way_in = await start(starter)

    assert way_in.room_url == A_ROOM
    assert len(served.asked) == 3
    assert {asked.body["dailyRoomProperties"]["exp"] for asked in served.asked} == {
        1_790_000_000 + 720
    }


async def test_pipecat_cloud_capacity_that_never_frees_names_the_agent():
    with starting(Answer(status=429, headers={"Retry-After": "0.05"})) as served:
        starter = starter_for(cloud_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter, window=0.4)

    assert refused.value.ending == NOT_ANSWERED
    assert str(refused.value).startswith(
        f'Pipecat Cloud had no free capacity for agent "{AN_AGENT}": it answered '
        "HTTP 429 to every start request for"
    )
    assert len(served.asked) > 1


async def test_a_self_hosted_starter_that_stays_busy_is_named():
    with starting(Answer(status=429, headers={"Retry-After": "0.05"})) as served:
        starter = starter_for(self_hosted_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter, window=0.4)
        named = served.wire_url.removeprefix("http://")

    assert refused.value.ending == NOT_ANSWERED
    assert str(refused.value).startswith(
        f"your start URL ({named}) answered HTTP 429 to every start request for"
    )


@pytest.mark.parametrize(
    ("status", "message", "ending"),
    [
        (
            401,
            f'Pipecat Cloud refused the start request for agent "{AN_AGENT}" (HTTP '
            "401): the public API key was not accepted. Check the connection's "
            "public API key; it starts with pk_ and belongs to the Pipecat Cloud "
            "organization that deploys this agent.",
            ERROR,
        ),
        (
            403,
            f'Pipecat Cloud refused the start request for agent "{AN_AGENT}" (HTTP '
            "403): the public API key was not accepted. Check the connection's "
            "public API key; it starts with pk_ and belongs to the Pipecat Cloud "
            "organization that deploys this agent.",
            ERROR,
        ),
        (
            404,
            f'Pipecat Cloud has no agent named "{AN_AGENT}" for this public API key '
            "(HTTP 404). Check the connection's Pipecat Cloud agent name; it is "
            "agent_name in pcc-deploy.toml.",
            ERROR,
        ),
        (
            400,
            f'Pipecat Cloud refused the start request for agent "{AN_AGENT}" '
            "(HTTP 400).",
            ERROR,
        ),
        (
            302,
            f'Pipecat Cloud refused the start request for agent "{AN_AGENT}" '
            "(HTTP 302).",
            ERROR,
        ),
    ],
)
async def test_pipecat_cloud_refusals_fail_at_once_with_their_cause(
    status: int, message: str, ending: str
):
    with starting(
        Answer(status=status, headers={"Location": "https://elsewhere.example/"})
    ) as served:
        starter = starter_for(cloud_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter)

    assert str(refused.value) == message
    assert refused.value.ending == ending
    assert len(served.asked) == 1
    assert A_PUBLIC_KEY not in str(refused.value)


async def test_pipecat_cloud_server_errors_are_retried_then_named():
    with starting(Answer(status=503, headers={"Retry-After": "0.05"})) as served:
        starter = starter_for(cloud_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter, window=0.4)

    assert str(refused.value) == (
        f'Egma could not reach Pipecat Cloud to start agent "{AN_AGENT}": HTTP 503.'
    )
    assert refused.value.ending == NOT_ANSWERED
    assert len(served.asked) > 1


async def test_pipecat_cloud_unreachable_is_retried_then_named(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(daily, "START_RETRY_SECONDS", (0.05,))
    closed = _closed_port_url()
    starter = starter_for(cloud_settings(), closed)
    with pytest.raises(MediaBackendError) as refused:
        await start(starter, window=0.4)

    assert str(refused.value) == (
        f'Egma could not reach Pipecat Cloud to start agent "{AN_AGENT}": the '
        "connection was refused."
    )
    assert refused.value.ending == NOT_ANSWERED
    assert starter.attempts > 1


@pytest.mark.parametrize(
    ("status", "tail", "ending"),
    [
        (
            401,
            "refused the start request (HTTP 401). Check the connection's auth "
            "headers.",
            ERROR,
        ),
        (
            403,
            "refused the start request (HTTP 403). Check the connection's auth "
            "headers.",
            ERROR,
        ),
        (404, "refused the start request (HTTP 404).", ERROR),
        (500, "refused the start request (HTTP 500).", ERROR),
        (307, "refused the start request (HTTP 307).", ERROR),
    ],
)
async def test_self_hosted_refusals_fail_at_once_with_their_cause(
    status: int, tail: str, ending: str
):
    with starting(Answer(status=status)) as served:
        starter = starter_for(self_hosted_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter)
        named = served.wire_url.removeprefix("http://")

    assert str(refused.value) == f"your start URL ({named}) {tail}"
    assert refused.value.ending == ending
    assert len(served.asked) == 1
    assert "SENTINEL" not in str(refused.value)


@pytest.mark.parametrize("status", [502, 503, 504, 530])
async def test_a_self_hosted_gateway_failure_is_unreachable_at_once(status: int):
    with starting(Answer(status=status)) as served:
        starter = starter_for(self_hosted_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter)
        named = served.wire_url.removeprefix("http://")

    assert str(refused.value) == (
        f"Egma could not reach your start URL ({named}): HTTP {status}."
    )
    assert refused.value.ending == NOT_ANSWERED
    assert len(served.asked) == 1


async def test_a_self_hosted_starter_that_is_down_is_unreachable_at_once():
    closed = _closed_port_url()
    starter = starter_for(self_hosted_settings(), closed)
    with pytest.raises(MediaBackendError) as refused:
        await start(starter)

    named = closed.removeprefix("http://")
    assert str(refused.value) == (
        f"Egma could not reach your start URL ({named}): the connection was refused."
    )
    assert refused.value.ending == NOT_ANSWERED
    assert starter.attempts == 1


def test_a_tunnel_start_url_that_cannot_be_reached_names_egma_agent_dev():
    tunnel = "https://quiet-river-1234.trycloudflare.com/start"
    starter = PipecatStarter(
        self_hosted_settings(tunnel),
        simulation_id=A_SIMULATION,
        body_params=None,
        max_duration_seconds=600,
        secrets=SecretRegistry(),
    )
    with pytest.raises(MediaBackendError) as refused:
        starter._answered(530, b"", None)

    assert str(refused.value) == (
        "Egma could not reach your start URL "
        "(quiet-river-1234.trycloudflare.com/start): HTTP 530. If this start URL "
        "belongs to egma agent dev, run `egma agent dev` on the machine that "
        "runs your bot, and start your bot's development runner there."
    )
    assert refused.value.ending == NOT_ANSWERED


@pytest.mark.parametrize(
    ("answer", "detail"),
    [
        (Answer(raw=b"<html>not json</html>"), "the answer is not a JSON object"),
        (Answer(body=["dailyRoom"]), "the answer is not a JSON object"),
        (Answer(body={"sessionId": "s"}), "the answer has no dailyRoom"),
        (
            Answer(body={"dailyRoom": "http://lakeside.daily.co/room"}),
            "dailyRoom is not an https URL on daily.co",
        ),
        (
            Answer(body={"dailyRoom": "https://10.0.0.4/room"}),
            "dailyRoom is not an https URL on daily.co",
        ),
        (
            Answer(body={"dailyRoom": "https://daily.co.evil.example/room"}),
            "dailyRoom is not an https URL on daily.co",
        ),
        (
            Answer(body={"dailyRoom": "https://user:pw@lakeside.daily.co/room"}),
            "dailyRoom is not an https URL on daily.co",
        ),
        (
            Answer(raw=b'{"dailyRoom": "' + b"a" * (70 * 1024) + b'"}'),
            "the answer is larger than 65536 bytes",
        ),
    ],
)
async def test_an_answer_without_a_usable_room_is_refused(answer: Answer, detail: str):
    with starting(answer) as served:
        starter = starter_for(cloud_settings(), served.wire_url)
        with pytest.raises(MediaBackendError) as refused:
            await start(starter)

    assert str(refused.value) == (
        f"the answer to the start request carried no usable Daily room: {detail}. "
        "Egma needs dailyRoom, an https URL on daily.co, in a JSON answer."
    )
    assert refused.value.ending == ERROR


async def test_the_daily_token_is_a_secret_once_it_arrives():
    secrets = SecretRegistry()
    with starting(
        Answer(body={"dailyRoom": A_ROOM, "dailyToken": "SENTINEL-daily-token"})
    ) as served:
        starter = LocalStarter(
            replace(cloud_settings(), start_url=served.wire_url),
            simulation_id=A_SIMULATION,
            body_params=None,
            max_duration_seconds=600,
            secrets=secrets,
        )
        await start(starter)

    assert "SENTINEL" not in secrets.redact("joined with SENTINEL-daily-token")


async def test_a_start_url_on_a_private_address_is_never_reached(
    monkeypatch: pytest.MonkeyPatch,
):
    class PrivateResolver:
        async def resolve(
            self, host: str, port: int = 0, family: int = socket.AF_INET
        ) -> list[dict[str, Any]]:
            return [
                {
                    "hostname": host,
                    "host": "10.0.0.4",
                    "port": port,
                    "family": socket.AF_INET,
                    "proto": socket.IPPROTO_TCP,
                    "flags": socket.AI_NUMERICHOST,
                }
            ]

        async def close(self) -> None:
            return None

    opened: list[object] = []

    def record_socket(*arguments: object, **_keywords: object) -> socket.socket:
        opened.append(arguments)
        raise OSError("stopped after the address policy")

    monkeypatch.setattr(socket, "socket", record_socket)
    starter = PipecatStarter(
        self_hosted_settings(),
        simulation_id=A_SIMULATION,
        body_params=None,
        max_duration_seconds=600,
        secrets=SecretRegistry(),
        endpoint_resolver=PrivateResolver(),
    )
    with pytest.raises(MediaBackendError) as refused:
        await start(starter)

    assert str(refused.value) == (
        "Egma could not reach your start URL (bots.lakeside-dental.example/start): "
        "it resolved to a non-public network address."
    )
    assert not opened


@pytest.mark.parametrize(
    ("access_variant", "config", "credentials", "said"),
    [
        (
            "daily_room.pipecat_cloud",
            {"agentName": ""},
            {"publicApiKey": A_PUBLIC_KEY},
            "needs config agentName",
        ),
        (
            "daily_room.pipecat_cloud",
            {"agentName": AN_AGENT, "startUrl": A_START_URL},
            {"publicApiKey": A_PUBLIC_KEY},
            "knows config key agentName only",
        ),
        (
            "daily_room.pipecat_cloud",
            {"agentName": AN_AGENT},
            {"headers": "{}"},
            "credentials.publicApiKey",
        ),
        (
            "daily_room.self_hosted",
            {"startUrl": "http://bots.example/start"},
            {"headers": '{"a": "b"}'},
            "needs config startUrl",
        ),
        (
            "daily_room.self_hosted",
            {"startUrl": A_START_URL},
            {"headers": "not json"},
            "credentials need headers",
        ),
        (
            "daily_room.elsewhere",
            {},
            None,
            "does not support access variant",
        ),
    ],
)
def test_an_unusable_connection_is_refused_before_anything_is_reached(
    access_variant: str, config: dict, credentials: Any, said: str
):
    with pytest.raises(MediaBackendError) as refused:
        StartSettings.from_connection(access_variant, config, credentials)
    assert said in str(refused.value)
    assert A_PUBLIC_KEY not in str(refused.value)


@pytest.mark.parametrize(
    ("builder", "expected", "ending"),
    [
        (
            lambda: daily.never_joined_failure(120, pipecat_cloud=True),
            "your bot did not join within 120 seconds. The start request was "
            "accepted, but no bot joined the Daily room. A Pipecat Cloud cold start "
            "can take this long: keep one instance warm with min_agents = 1 in "
            "pcc-deploy.toml. Also check your bot's logs for a crash at start.",
            AGENT_NEVER_JOINED,
        ),
        (
            lambda: daily.never_joined_failure(120, pipecat_cloud=False),
            "your bot did not join within 120 seconds. The start request was "
            "accepted, but no bot joined the Daily room. Check your starter's and "
            "your bot's logs for a crash at start.",
            AGENT_NEVER_JOINED,
        ),
        (
            lambda: daily.no_hello_failure(120),
            "your bot joined but did not report to Egma within 120 seconds. Check "
            "that the bot calls await simulation(worker, runner_args) from "
            "egma.pipecat before the runner starts the worker, that egma[pipecat] "
            "is installed, and that EGMA_URL and EGMA_API_KEY are set where the bot "
            "runs (on Pipecat Cloud: in the agent's secret set, then redeploy).",
            ERROR,
        ),
        (
            lambda: daily.hello_refused_failure(
                904, "this hello speaks protocol version 2, and Egma speaks 1."
            ),
            "your bot reported to Egma and Egma refused the report (this hello "
            "speaks protocol version 2, and Egma speaks 1.), so no tool was "
            "isolated.",
            ERROR,
        ),
        (
            lambda: daily.rtvi_off_failure(120),
            "your bot has RTVI turned off: it joined the Daily room and reported "
            "to Egma but never sent RTVI bot-ready within 120 seconds, so Egma "
            "cannot send it text. Chat simulations need RTVI, which Pipecat turns "
            "on by default; voice simulations still work.",
            ERROR,
        ),
        (
            lambda: daily.no_audio_failure(120),
            "your bot joined and reported to Egma but published no audio track "
            "within 120 seconds. Check that the bot's pipeline sends audio out "
            "through the Daily transport.",
            ERROR,
        ),
        (
            lambda: daily.during_startup(daily.no_hello_failure(30), 30),
            "your bot joined but did not report to Egma within 30 seconds. Check "
            "that the bot calls await simulation(worker, runner_args) from "
            "egma.pipecat before the runner starts the worker, that egma[pipecat] "
            "is installed, and that EGMA_URL and EGMA_API_KEY are set where the bot "
            "runs (on Pipecat Cloud: in the agent's secret set, then redeploy).; "
            "the simulation's configured 30s duration expired during startup",
            ERROR,
        ),
    ],
)
def test_the_readiness_failures_say_the_contract_words(
    builder: Any, expected: str, ending: str
):
    failure = builder()
    assert str(failure) == expected
    assert failure.ending == ending


def _closed_port_url() -> str:
    with socket.socket() as held:
        held.bind(("127.0.0.1", 0))
        port = held.getsockname()[1]
    return f"http://127.0.0.1:{port}/start"
