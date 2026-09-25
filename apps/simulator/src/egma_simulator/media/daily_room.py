"""Pipecat bots reached through a start request and a Daily room.

access_variant selects the starter:
- Pipecat Cloud: POST to Pipecat Cloud's public start endpoint for agentName,
  authorised with the public API key.
- Self-hosted: POST to the customer's start URL with the stored headers and
  ``transport: "daily"``.

Egma registers the provider reference (the simulation id) before the first
start request. The starter makes the Daily room and starts the bot; Egma joins
the room the answer names as an RTVI client, and never names, stops or deletes
a room. The room expiry in the start request is the backstop.

Readiness needs three facts within PIPECAT_STARTUP_SECONDS of the first start
request: Egma's server accepted the SDK's hello, a participant other than the
persona is in the room, and that participant's audio track is present (voice)
or its RTVI bot-ready arrived (chat).

Start requests follow the token endpoint's safety rules: no redirects, bounded
time and answer size, public addresses only. The request body is never logged.
Daily imports stay lazy so other connection types never load the native library.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlsplit

from ..client import AgentReport
from ..contract import AGENT_NEVER_JOINED, ERROR, NOT_ANSWERED
from ..platform_logging import log_event
from ..redaction import SecretRegistry
from . import (
    MediaBackendError,
    PlayoutClearAcknowledger,
    PlayoutStamp,
    RemoteParticipantLeftFrame,
    VoiceMedia,
    arrived_now,
    first_of,
)
from .guarded_http import (
    guarded_connector,
    guarded_post,
    header_object,
    refused_for_address,
)

logger = logging.getLogger(__name__)

PIPECAT_CLOUD = "daily_room.pipecat_cloud"
SELF_HOSTED = "daily_room.self_hosted"

PIPECAT_CLOUD_START = "https://api.pipecat.daily.co/v1/public/{agent}/start"
"""Pipecat Cloud's public start endpoint; the agent name is one path segment."""

PIPECAT_STARTUP_SECONDS = 120.0
"""Readiness window from the first start request, covering a cold start."""

START_REQUEST_SECONDS = 30.0
"""Longest wait for one start request's answer."""

START_RESPONSE_BYTES = 64 * 1024
"""The most start-request answer data read into the simulator."""

START_RETRY_SECONDS = (1.0, 2.0, 4.0, 5.0)
"""Pauses between retried start requests without Retry-After; the last repeats."""

LONGEST_RETRY_AFTER_SECONDS = 30.0
"""The most of a Retry-After answer honoured before the next start request."""

ROOM_EXPIRY_MARGIN_SECONDS = 120
"""Room lifetime beyond the simulation's duration limit."""

JOIN_SECONDS = 30.0
"""Longest wait for the persona to enter the room."""

AGENT_REPORT_POLL_SECONDS = 1.0
"""Pause between reads of the agent report from Egma's server during startup."""

AGENT_REPORT_WATCH_SECONDS = 2.0
"""Pause between reads of the agent report after readiness. A later refused
hello (a mocked Pipecat Flows function the flow offers) ends the simulation."""

AUDIO_DRAIN_SECONDS = 2.0
"""Longest wait for a departing bot's buffered audio to pass the input."""

PERSONA_NAME = "egma-persona"
"""The persona's Daily user name."""

TUNNEL_HOST_SUFFIX = ".trycloudflare.com"
"""Host suffix of the quick-tunnel addresses `egma agent dev` writes."""

SELF_HOSTED_UNREACHABLE_STATUSES = frozenset({502, 503, 504, 530})
"""Self-hosted answers that mean the starter could not be reached."""

DAILY_ROOM_HOST_SUFFIX = ".daily.co"
"""Every Daily room URL is on a subdomain of daily.co."""

RTVI_LABEL = "rtvi-ai"


# -- What each failure says ------------------------------------------------------
# Each sentence names the cause and the next step. Public docs quote them, so
# tests pin them word for word.


def _seconds(seconds: float) -> str:
    return f"{seconds:.0f} seconds"


def bad_key_failure(agent: str, status: int) -> MediaBackendError:
    return MediaBackendError(
        f'Pipecat Cloud refused the start request for agent "{agent}" (HTTP '
        f"{status}): the public API key was not accepted. Check the connection's "
        "public API key; it starts with pk_ and belongs to the Pipecat Cloud "
        "organization that deploys this agent.",
        ending=ERROR,
    )


def unknown_agent_failure(agent: str) -> MediaBackendError:
    return MediaBackendError(
        f'Pipecat Cloud has no agent named "{agent}" for this public API key '
        "(HTTP 404). Check the connection's Pipecat Cloud agent name; it is "
        "agent_name in pcc-deploy.toml.",
        ending=ERROR,
    )


def cloud_no_capacity_failure(agent: str, seconds: float) -> MediaBackendError:
    return MediaBackendError(
        f'Pipecat Cloud had no free capacity for agent "{agent}": it answered '
        f"HTTP 429 to every start request for {_seconds(seconds)}. Raise the "
        "agent's max_agents in Pipecat Cloud, or run fewer simulations at once.",
        ending=NOT_ANSWERED,
    )


def cloud_unreachable_failure(agent: str, cause: str) -> MediaBackendError:
    return MediaBackendError(
        f'Egma could not reach Pipecat Cloud to start agent "{agent}": {cause}.',
        ending=NOT_ANSWERED,
    )


def cloud_refused_failure(agent: str, status: int) -> MediaBackendError:
    return MediaBackendError(
        f'Pipecat Cloud refused the start request for agent "{agent}" (HTTP {status}).',
        ending=ERROR,
    )


def start_unreachable_failure(start_url: str, cause: str) -> MediaBackendError:
    advice = (
        " If this start URL belongs to egma agent dev, run `egma agent dev` on "
        "the machine that runs your bot, and start your bot's development "
        "runner there."
        if _is_tunnel(start_url)
        else ""
    )
    return MediaBackendError(
        f"Egma could not reach your start URL ({_start_named(start_url)}): "
        f"{cause}.{advice}",
        ending=NOT_ANSWERED,
    )


def start_auth_failure(start_url: str, status: int) -> MediaBackendError:
    return MediaBackendError(
        f"your start URL ({_start_named(start_url)}) refused the start request "
        f"(HTTP {status}). Check the connection's auth headers.",
        ending=ERROR,
    )


def start_busy_failure(start_url: str, seconds: float) -> MediaBackendError:
    return MediaBackendError(
        f"your start URL ({_start_named(start_url)}) answered HTTP 429 to every "
        f"start request for {_seconds(seconds)}.",
        ending=NOT_ANSWERED,
    )


def start_refused_failure(start_url: str, status: int) -> MediaBackendError:
    return MediaBackendError(
        f"your start URL ({_start_named(start_url)}) refused the start request "
        f"(HTTP {status}).",
        ending=ERROR,
    )


def unusable_room_failure(detail: str) -> MediaBackendError:
    return MediaBackendError(
        f"the answer to the start request carried no usable Daily room: {detail}. "
        "Egma needs dailyRoom, an https URL on daily.co, in a JSON answer.",
        ending=ERROR,
    )


def never_joined_failure(seconds: float, *, pipecat_cloud: bool) -> MediaBackendError:
    logs = "your bot's logs" if pipecat_cloud else "your starter's and your bot's logs"
    settings = (
        "in the agent's secret set on Pipecat Cloud, then redeploy"
        if pipecat_cloud
        else "where the bot runs"
    )
    return MediaBackendError(
        f"your bot did not join within {_seconds(seconds)}. The start request "
        f"was accepted, but no bot joined the Daily room. Check {logs}: "
        "NotReported means the bot could not reach Egma, so check EGMA_URL and "
        f"EGMA_API_KEY {settings}. A crash at start has the same effect.",
        ending=AGENT_NEVER_JOINED,
    )


def no_hello_failure(seconds: float) -> MediaBackendError:
    return MediaBackendError(
        f"your bot joined but did not report to Egma within {_seconds(seconds)}. "
        "Check that the bot calls await simulation(worker, runner_args) from "
        "egma.pipecat before the runner starts the worker, that egma[pipecat] is "
        "installed, and that EGMA_URL and EGMA_API_KEY are set where the bot runs "
        "(on Pipecat Cloud: in the agent's secret set, then redeploy).",
        ending=ERROR,
    )


FLOWS_FUNCTION_MOCKED = 905
"""The hello refusal code for a mocked Pipecat Flows function."""


def hello_refused_failure(code: int | None, message: str) -> MediaBackendError:
    if code == FLOWS_FUNCTION_MOCKED:
        return MediaBackendError(message, ending=ERROR)
    return MediaBackendError(
        f"your bot reported to Egma and Egma refused the report ({message}), so "
        "no tool was isolated.",
        ending=ERROR,
    )


def rtvi_off_failure(seconds: float) -> MediaBackendError:
    return MediaBackendError(
        "your bot has RTVI turned off: it joined the Daily room and reported to "
        f"Egma but never sent RTVI bot-ready within {_seconds(seconds)}, so Egma "
        "cannot send it text. Chat simulations need RTVI, which Pipecat turns on "
        "by default; voice simulations still work.",
        ending=ERROR,
    )


def no_audio_failure(seconds: float) -> MediaBackendError:
    return MediaBackendError(
        "your bot joined and reported to Egma but published no audio track "
        f"within {_seconds(seconds)}. Check that the bot's pipeline sends audio "
        "out through the Daily transport.",
        ending=ERROR,
    )


def during_startup(failure: MediaBackendError, seconds: float) -> MediaBackendError:
    """A startup failure named when the duration limit ended the startup."""
    return MediaBackendError(
        f"{failure}; the simulation's configured {seconds:g}s duration expired "
        "during startup",
        ending=failure.ending,
    )


# -- The connection ------------------------------------------------------------------


@dataclass(frozen=True)
class StartSettings:
    """Where a start request goes and how it is authorised."""

    start_url: str
    headers: dict[str, str] = field(repr=False)
    agent_name: str = ""
    """The Pipecat Cloud agent; empty for a self-hosted starter."""

    @property
    def pipecat_cloud(self) -> bool:
        return bool(self.agent_name)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret these settings hold, for redaction."""
        held = list(self.headers.values())
        for value in self.headers.values():
            scheme, _, rest = value.partition(" ")
            if scheme.lower() == "bearer" and rest.strip():
                held.append(rest.strip())
        return tuple(value for value in held if value)

    @classmethod
    def from_connection(
        cls, access_variant: str, config: Mapping[str, Any], credentials: Any
    ) -> StartSettings:
        """Read one connection block, or refuse it in a sentence."""
        if access_variant == PIPECAT_CLOUD:
            return cls._pipecat_cloud(config, credentials)
        if access_variant == SELF_HOSTED:
            return cls._self_hosted(config, credentials)
        raise MediaBackendError(
            f"the daily-room adapter does not support access variant {access_variant!r}"
        )

    @classmethod
    def _pipecat_cloud(
        cls, config: Mapping[str, Any], credentials: Any
    ) -> StartSettings:
        unknown = set(config) - {"agentName"}
        if unknown:
            raise MediaBackendError(
                "a Pipecat Cloud connection knows config key agentName only; "
                f"{sorted(unknown)} is read by nobody"
            )
        agent_name = config.get("agentName")
        if not isinstance(agent_name, str) or not agent_name.strip():
            raise MediaBackendError(
                "a Pipecat Cloud connection needs config agentName, the agent "
                "name in pcc-deploy.toml"
            )
        if not isinstance(credentials, dict) or set(credentials) != {"publicApiKey"}:
            raise MediaBackendError(
                "a Pipecat Cloud connection carries its public API key under "
                "credentials.publicApiKey and nothing else"
            )
        key = credentials.get("publicApiKey")
        if not isinstance(key, str) or not key.strip():
            raise MediaBackendError(
                "a Pipecat Cloud connection's credentials.publicApiKey must be a "
                "non-empty string"
            )
        agent_name = agent_name.strip()
        return cls(
            start_url=PIPECAT_CLOUD_START.format(agent=quote(agent_name, safe="")),
            headers={"Authorization": f"Bearer {key.strip()}"},
            agent_name=agent_name,
        )

    @classmethod
    def _self_hosted(cls, config: Mapping[str, Any], credentials: Any) -> StartSettings:
        unknown = set(config) - {"startUrl"}
        if unknown:
            raise MediaBackendError(
                "a self-hosted Pipecat connection knows config key startUrl only; "
                f"{sorted(unknown)} is read by nobody"
            )
        start_url = config.get("startUrl")
        if not isinstance(start_url, str) or not _https_with_host(start_url.strip()):
            raise MediaBackendError(
                "a self-hosted Pipecat connection needs config startUrl, an https "
                "URL with a hostname, like https://bots.example.com/start"
            )
        headers = (
            header_object(credentials.get("headers"))
            if isinstance(credentials, dict) and set(credentials) == {"headers"}
            else None
        )
        if headers is None:
            raise MediaBackendError(
                "a self-hosted Pipecat connection's credentials need headers, a "
                "JSON object of header name to header value"
            )
        return cls(start_url=start_url.strip(), headers=headers)


_HOST_NAME = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
"""A DNS host name: dot-separated labels of letters, digits and inner hyphens."""


def _https_host(url: str) -> str | None:
    """The lowercase host name of an https URL, or None for anything else.

    Backslashes, whitespace and control characters are refused outright: URL
    parsers disagree about them (a WHATWG parser reads a backslash as a slash),
    so the host checked here could differ from the host a client connects to.
    """
    if any(
        character == "\\"
        or character.isspace()
        or ord(character) < 0x20
        or ord(character) == 0x7F
        for character in url
    ):
        return None
    try:
        parsed = urlsplit(url)
        _ = parsed.port
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if (
        not url.lower().startswith("https://")
        or parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or not _HOST_NAME.match(host)
    ):
        return None
    return host


def _https_with_host(url: str) -> bool:
    return _https_host(url) is not None


def _is_tunnel(url: str) -> bool:
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return False
    return host.lower().endswith(TUNNEL_HOST_SUFFIX)


def _start_named(url: str) -> str:
    """A start URL as failures name it: host (and port) plus path."""
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        port = parsed.port
    except ValueError:
        return url
    return f"{host}{f':{port}' if port is not None else ''}{parsed.path}"


def _daily_room_url(url: str) -> bool:
    """Whether an answered room is an https URL on a subdomain of daily.co."""
    host = _https_host(url)
    return host is not None and host.endswith(DAILY_ROOM_HOST_SUFFIX)


@dataclass(frozen=True)
class DailyWayIn:
    """The room a starter made, and the token it handed over, if any."""

    room_url: str
    token: str | None = field(default=None, repr=False)


# -- The start request ---------------------------------------------------------------


@dataclass(frozen=True)
class _Retry:
    """A start request that may be sent again inside the readiness window."""

    status: int | None
    cause: str
    after: float | None = None


class _Unreachable(Exception):
    """A start request that got no HTTP answer, with its cause in words."""

    def __init__(self, cause: str) -> None:
        super().__init__(cause)
        self.cause = cause


class PipecatStarter:
    """Sends start requests for one simulation and reads their answers."""

    def __init__(
        self,
        settings: StartSettings,
        *,
        simulation_id: str,
        body_params: Mapping[str, Any] | None,
        max_duration_seconds: float,
        secrets: SecretRegistry,
        modality: str = "voice",
        endpoint_resolver: Any = None,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._settings = settings
        self._simulation_id = simulation_id
        self._modality = modality
        self._body_params = dict(body_params or {})
        self._max_duration_seconds = max_duration_seconds
        self._secrets = secrets
        self._endpoint_resolver = endpoint_resolver
        self._wall_clock = wall_clock
        self._expiry: int | None = None
        self.attempts = 0
        self.last_retry: _Retry | None = None

    def request_body(self) -> dict[str, Any]:
        """Pipecat's start shape; egma's key goes last in the bot's body.

        The room expiry is fixed at the first start request and repeated on
        every retry.
        """
        if self._expiry is None:
            self._expiry = (
                math.floor(self._wall_clock())
                + math.ceil(self._max_duration_seconds)
                + ROOM_EXPIRY_MARGIN_SECONDS
            )
        body = dict(self._body_params)
        body.pop("egma", None)
        body["egma"] = {
            "simulation_id": self._simulation_id,
            "modality": self._modality,
        }
        asked: dict[str, Any] = {
            "createDailyRoom": True,
            "dailyRoomProperties": {"exp": self._expiry, "eject_at_room_exp": True},
            "body": body,
        }
        if not self._settings.pipecat_cloud:
            asked["transport"] = "daily"
        return asked

    async def start(self, *, deadline: float) -> DailyWayIn:
        """Start the bot, retrying what may be retried until the deadline."""
        loop = asyncio.get_running_loop()
        began = loop.time()
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise self.out_of_time(deadline - began)
            outcome = await self._attempt(min(START_REQUEST_SECONDS, remaining))
            if isinstance(outcome, DailyWayIn):
                return outcome
            self.last_retry = outcome
            pause = (
                outcome.after
                if outcome.after is not None
                else START_RETRY_SECONDS[
                    min(self.attempts - 1, len(START_RETRY_SECONDS) - 1)
                ]
            )
            if loop.time() + pause >= deadline:
                raise self.out_of_time(deadline - began)
            log_event(
                logger,
                logging.INFO,
                "egma.pipecat.start_retried",
                "start request will be sent again",
                attributes={
                    "egma.pipecat.start_attempt": self.attempts,
                    "http.response.status_code": outcome.status or 0,
                },
            )
            await asyncio.sleep(pause)

    def out_of_time(self, seconds: float) -> MediaBackendError:
        """The failure for a window that ended while start requests were retried."""
        settings = self._settings
        retry = self.last_retry
        if settings.pipecat_cloud:
            if retry is not None and retry.status == 429:
                return cloud_no_capacity_failure(settings.agent_name, seconds)
            cause = retry.cause if retry is not None else "no answer in time"
            return cloud_unreachable_failure(settings.agent_name, cause)
        if retry is not None and retry.status == 429:
            return start_busy_failure(settings.start_url, seconds)
        return start_unreachable_failure(settings.start_url, "no answer in time")

    async def _attempt(self, seconds: float) -> DailyWayIn | _Retry:
        self.attempts += 1
        try:
            status, said, retry_after = await self._post_once(seconds)
        except _Unreachable as unreachable:
            if self._settings.pipecat_cloud:
                return _Retry(status=None, cause=unreachable.cause)
            raise start_unreachable_failure(
                self._settings.start_url, unreachable.cause
            ) from unreachable
        return self._answered(status, said, retry_after)

    def _answered(
        self, status: int, said: bytes, retry_after: float | None
    ) -> DailyWayIn | _Retry:
        settings = self._settings
        if 200 <= status < 300:
            return self._room_in(said)
        if status == 429:
            return _Retry(status=status, cause="HTTP 429", after=retry_after)
        if settings.pipecat_cloud:
            if status in (401, 403):
                raise bad_key_failure(settings.agent_name, status)
            if status == 404:
                raise unknown_agent_failure(settings.agent_name)
            if status >= 500:
                return _Retry(status=status, cause=f"HTTP {status}", after=retry_after)
            raise cloud_refused_failure(settings.agent_name, status)
        if status in SELF_HOSTED_UNREACHABLE_STATUSES:
            raise start_unreachable_failure(settings.start_url, f"HTTP {status}")
        if status in (401, 403):
            raise start_auth_failure(settings.start_url, status)
        raise start_refused_failure(settings.start_url, status)

    def _room_in(self, said: bytes) -> DailyWayIn:
        if len(said) > START_RESPONSE_BYTES:
            raise unusable_room_failure(
                f"the answer is larger than {START_RESPONSE_BYTES} bytes"
            )
        try:
            held = json.loads(said)
        except ValueError:
            held = None
        if not isinstance(held, dict):
            raise unusable_room_failure("the answer is not a JSON object")
        token = held.get("dailyToken")
        if isinstance(token, str) and token.strip():
            token = token.strip()
            self._secrets.register([token])
        else:
            token = None
        room_url = held.get("dailyRoom")
        if not isinstance(room_url, str) or not room_url.strip():
            raise unusable_room_failure("the answer has no dailyRoom")
        room_url = room_url.strip()
        if not _daily_room_url(room_url):
            raise unusable_room_failure("dailyRoom is not an https URL on daily.co")
        return DailyWayIn(room_url=room_url, token=token)

    def _endpoint_connector(self, aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
        """Build the guarded connector used for every start request."""
        return guarded_connector(aiohttp, resolver)

    async def _post_once(self, seconds: float) -> tuple[int, bytes, float | None]:
        """One start request: its status, its bounded 2xx body, its Retry-After.

        Sent direct, never through a proxy: its credentials are the spec's own
        values, and the address guard must see the real destination.
        """
        try:
            answer = await guarded_post(
                self._settings.start_url,
                json_body=self.request_body(),
                headers=self._settings.headers,
                seconds=seconds,
                limit=START_RESPONSE_BYTES,
                resolver=self._endpoint_resolver,
                connector_for=self._endpoint_connector,
            )
        except Exception as failed:
            cause = _network_cause(failed, seconds)
            if cause is None:
                raise
            raise _Unreachable(cause) from failed
        return (
            answer.status,
            answer.body,
            _retry_after(answer.headers.get("retry-after")),
        )


def _network_cause(failed: BaseException, seconds: float) -> str | None:
    """Name a known network failure; None for anything else, which propagates."""
    import aiohttp

    if refused_for_address(failed):
        return "it resolved to a non-public network address"
    if isinstance(failed, asyncio.TimeoutError):
        return f"no answer within {seconds:.0f} seconds"
    dns_error = getattr(aiohttp, "ClientConnectorDNSError", None)
    if dns_error is not None and isinstance(failed, dns_error):
        return "the name did not resolve"
    if isinstance(failed, (aiohttp.ClientSSLError, aiohttp.ServerFingerprintMismatch)):
        return "TLS failed"
    if isinstance(failed, aiohttp.ClientConnectorError):
        return "the connection was refused"
    if isinstance(failed, (aiohttp.ClientError, OSError)):
        return "the connection failed"
    return None


def _retry_after(written: str | None) -> float | None:
    """Retry-After in seconds, when it is a non-negative number."""
    if written is None:
        return None
    try:
        seconds = float(written.strip())
    except ValueError:
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return min(seconds, LONGEST_RETRY_AFTER_SECONDS)


# -- The agent report, read from Egma's server -----------------------------------------


AgentReportProbe = Callable[[], Awaitable[AgentReport]]


class AgentReportLost(Exception):
    """Egma's server says this simulator no longer holds the simulation."""


# -- RTVI ------------------------------------------------------------------------


def rtvi_message(kind: str, data: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """One RTVI client message with a fresh id."""
    message: dict[str, Any] = {
        "label": RTVI_LABEL,
        "type": kind,
        "id": uuid.uuid4().hex,
    }
    if data is not None:
        message["data"] = dict(data)
    return message


def client_ready_message() -> dict[str, Any]:
    from pipecat.processors.frameworks.rtvi.models import PROTOCOL_VERSION

    return rtvi_message(
        "client-ready",
        {
            "version": PROTOCOL_VERSION,
            "about": {"library": "egma-simulator", "platform": "python"},
        },
    )


def send_text_message(text: str) -> dict[str, Any]:
    return rtvi_message(
        "send-text",
        {
            "content": text,
            "options": {"run_immediately": True, "audio_response": False},
        },
    )


def _rtvi_type(message: Any) -> str | None:
    if not isinstance(message, dict) or message.get("label") != RTVI_LABEL:
        return None
    kind = message.get("type")
    return kind if isinstance(kind, str) else None


def _rtvi_data(message: Mapping[str, Any]) -> Mapping[str, Any]:
    data = message.get("data")
    return data if isinstance(data, dict) else {}


# -- Readiness ---------------------------------------------------------------------


class PipecatStartup:
    """Latched startup facts for one bot, fed by room events and the agent report."""

    def __init__(self) -> None:
        self.changed = asyncio.Event()
        self.local_id: str | None = None
        self.self_joined = False
        """Whether the persona's own join has completed."""
        self.bot_id: str | None = None
        self.bot_audio = False
        self.bot_ready = False
        self.bot_left = False
        self.report = AgentReport()
        self.report_lost = False

    def _touch(self) -> None:
        self.changed.set()

    async def until(
        self, condition: Callable[[], bool], *, within: float | None
    ) -> bool:
        """Wait until ``condition`` holds; False when ``within`` seconds pass."""
        loop = asyncio.get_running_loop()
        deadline = None if within is None else loop.time() + within
        while not condition():
            left = None if deadline is None else deadline - loop.time()
            if left is not None and left <= 0:
                return False
            self.changed.clear()
            await first_of(self.changed, within=left)
        return True

    def joined(self, data: Mapping[str, Any]) -> None:
        """Note the persona's completed join and its own participant id."""
        participants = data.get("participants")
        local = participants.get("local") if isinstance(participants, dict) else None
        local_id = local.get("id") if isinstance(local, dict) else None
        if isinstance(local_id, str) and local_id:
            self.local_id = local_id
        self.self_joined = True
        self._touch()

    def participant_seen(self, participant: Mapping[str, Any]) -> bool:
        """Note one remote participant; True the first time the bot is seen.

        The first participant other than the persona is the bot.
        """
        participant_id = participant.get("id")
        info = participant.get("info")
        if not isinstance(participant_id, str) or not participant_id:
            return False
        if participant_id == self.local_id or (
            isinstance(info, dict) and info.get("isLocal")
        ):
            return False
        first = self.bot_id is None
        if first:
            self.bot_id = participant_id
        if participant_id == self.bot_id:
            if _microphone_playable(participant):
                self.bot_audio = True
            self._touch()
        return first

    def audio_arrived(self, participant_id: str | None) -> None:
        if self.bot_id is not None and participant_id in (None, self.bot_id):
            if not self.bot_audio:
                self.bot_audio = True
                self._touch()

    def participant_left(self, participant_id: str) -> bool:
        """Note a departure; True when the bot left."""
        if participant_id != self.bot_id:
            return False
        self.bot_left = True
        self._touch()
        return True

    def from_bot(self, sender: str | None) -> bool:
        """Whether an app message came from the bot."""
        return sender is None or (sender == self.bot_id and sender != self.local_id)

    def rtvi(self, message: Any) -> None:
        if _rtvi_type(message) == "bot-ready" and not self.bot_ready:
            self.bot_ready = True
            self._touch()

    def reported(self, report: AgentReport) -> None:
        self.report = report
        self._touch()

    def pending_condition(self, *, voice: bool) -> str:
        """The first missing fact: a refused report, then the bot, then its hello,
        then bot-ready (chat) or its audio track (voice)."""
        if self.report.state == "refused":
            return "hello_refused"
        if self.bot_id is None:
            return "bot_join"
        if self.report.state != "accepted":
            return "egma_hello"
        if not voice and not self.bot_ready:
            return "rtvi_bot_ready"
        if voice and not self.bot_audio:
            return "audio_track"
        return "ready"


def _microphone_playable(participant: Mapping[str, Any]) -> bool:
    media = participant.get("media")
    microphone = media.get("microphone") if isinstance(media, dict) else None
    return isinstance(microphone, dict) and microphone.get("state") == "playable"


# -- The rooms -------------------------------------------------------------------------


@dataclass(frozen=True)
class RoomEvents:
    """What a room reports to the lifecycle that owns it."""

    joined: Callable[[Mapping[str, Any]], None]
    participant: Callable[[Mapping[str, Any]], None]
    left: Callable[[str], Awaitable[None]]
    message: Callable[[Any, str | None], Any]
    audio: Callable[[str | None], None]


class DailyVoiceRoom:
    """One Pipecat Daily transport, owned by the conductor's only pipeline."""

    def __init__(
        self,
        *,
        way_in: DailyWayIn,
        events: RoomEvents,
        quotable: Callable[[str], str],
    ) -> None:
        self._way_in = way_in
        self._events = events
        self._quotable = quotable
        self._transport: Any = None
        self._input: Any = None
        self._connected = asyncio.Event()
        self._leaving = False
        self._join_error: str | None = None
        self._departure: asyncio.Task[None] | None = None
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self.fault: str | None = None
        """Set with ``failed`` when the lifecycle ends the simulation itself."""

    def create_transport(self, *, audio_out_mixer: object = None) -> VoiceMedia:
        """Build the stock Daily input and output processors."""
        from pipecat.frames.frames import Frame, InputAudioRawFrame
        from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
        from pipecat.transports.daily.transport import DailyParams, DailyTransport

        transport = DailyTransport(
            self._way_in.room_url,
            self._way_in.token,
            PERSONA_NAME,
            params=DailyParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                audio_out_sample_rate=24_000,
                audio_out_mixer=audio_out_mixer,
                camera_out_enabled=False,
                # One renderer per participant and source. The other mode reads
                # Daily's virtual speaker, which is one per process.
                audio_in_user_tracks=True,
            ),
        )
        self._transport = transport
        self._input = transport.input()
        room = self
        events = self._events

        @transport.event_handler("on_joined")
        async def _joined(_transport: object, data: Any) -> None:
            events.joined(data if isinstance(data, dict) else {})
            room._connected.set()
            with contextlib.suppress(Exception):
                for key, participant in transport.participants().items():
                    if key != "local" and isinstance(participant, dict):
                        events.participant(participant)

        @transport.event_handler("on_participant_joined")
        async def _arrived(_transport: object, participant: Any) -> None:
            if isinstance(participant, dict):
                events.participant(participant)

        @transport.event_handler("on_participant_updated")
        async def _updated(_transport: object, participant: Any) -> None:
            if isinstance(participant, dict):
                events.participant(participant)

        @transport.event_handler("on_participant_left")
        async def _left(_transport: object, participant: Any, _reason: Any) -> None:
            if room._leaving or not isinstance(participant, dict):
                return
            participant_id = participant.get("id")
            if isinstance(participant_id, str):
                await events.left(participant_id)

        @transport.event_handler("on_app_message")
        async def _message(_transport: object, message: Any, sender: Any) -> None:
            events.message(message, sender if isinstance(sender, str) else None)

        @transport.event_handler("on_error")
        async def _error(_transport: object, error: Any) -> None:
            if not room._connected.is_set():
                room._join_error = room._quotable(str(error))
            if not room._leaving:
                room.failed.set()

        @transport.event_handler("on_before_leave")
        async def _before_leave(_transport: object) -> None:
            # Pipecat leaves when the pipeline ends; that leave is Egma's own.
            room._leaving = True

        @transport.event_handler("on_call_state_updated")
        async def _state(_transport: object, state: Any) -> None:
            if state == "left" and not room._leaving and not room.ended.is_set():
                room.failed.set()

        class _Arrival(FrameProcessor):
            """Stamp inbound audio on arrival and note whose audio it is."""

            async def process_frame(
                self, frame: Frame, direction: FrameDirection
            ) -> None:
                await super().process_frame(frame, direction)
                if isinstance(frame, InputAudioRawFrame):
                    arrived_now(frame)
                    user_id = getattr(frame, "user_id", None)
                    events.audio(user_id if isinstance(user_id, str) else None)
                await self.push_frame(frame, direction)

        return VoiceMedia(
            input=(self._input, _Arrival()),
            output=(
                PlayoutClearAcknowledger(),
                transport.output(),
                PlayoutStamp(wait_for_playout=True, acknowledged_clears=True),
            ),
            ended=self.ended,
            failed=self.failed,
            transport_name="Daily room",
            fault=lambda: room.fault,
        )

    async def wait_joined(self, within: float) -> None:
        """Wait for the running transport to enter the room."""
        if not await first_of(
            self._connected, self.failed, self.ended, within=max(0.0, within)
        ):
            raise MediaBackendError(
                f"Egma could not join the Daily room within {within:.0f}s",
                ending=ERROR,
            )
        if not self._connected.is_set():
            detail = f": {self._join_error}" if self._join_error else ""
            raise MediaBackendError(
                f"Egma could not join the Daily room{detail}", ending=ERROR
            )

    async def send(self, message: Mapping[str, Any]) -> None:
        """Send one app message to everyone in the room."""
        from pipecat.transports.daily.transport import (
            DailyOutputTransportMessageUrgentFrame,
        )

        if self._transport is None:
            raise MediaBackendError("a message was sent before the room existed")
        await self._transport.output().send_message(
            DailyOutputTransportMessageUrgentFrame(message=dict(message))
        )

    async def bot_departed(self) -> None:
        """Order the bot's departure after its buffered audio, then mark ended."""
        if self._departure is None:
            self._departure = asyncio.create_task(
                self._drain_departure(), name="daily-bot-departure"
            )
        await asyncio.shield(self._departure)

    async def _drain_departure(self) -> None:
        """Push the departure marker behind every audio frame already received.

        Pipecat 1.9.0's Daily client queues renderer callbacks in ``_audio_queue``
        and the input transport queues frames in ``_audio_in_queue``; both are
        joined before the marker so it cannot overtake the bot's last words.
        """
        try:
            async with asyncio.timeout(AUDIO_DRAIN_SECONDS):
                client = getattr(self._transport, "_client", None)
                for pending in (
                    getattr(client, "_audio_queue", None),
                    getattr(self._input, "_audio_in_queue", None),
                ):
                    if not isinstance(pending, asyncio.Queue):
                        raise RuntimeError(
                            "pipecat no longer exposes its daily audio queues"
                        )
                    await pending.join()
                acknowledged = asyncio.Event()
                await self._input.push_frame(
                    RemoteParticipantLeftFrame(completed=acknowledged)
                )
                await acknowledged.wait()
            self.ended.set()
        except Exception as undrained:
            if not self._leaving:
                logger.warning(
                    "the bot's departure could not be ordered after its audio: %r",
                    undrained,
                )
                self.failed.set()

    async def leave(self) -> None:
        """Release transport handlers after the pipeline has ended."""
        transport, self._transport = self._transport, None
        self._leaving = True
        self.ended.set()
        departure = self._departure
        if departure is not None and not departure.done():
            departure.cancel()
            await asyncio.gather(departure, return_exceptions=True)
        if transport is not None:
            try:
                await transport.cleanup()
            except Exception as unfinished:
                logger.warning(
                    "the Daily transport did not clean up: %s",
                    self._quotable(repr(unfinished)),
                )


def _initialize_daily() -> None:
    """Initialise daily-python once per process, sharing Pipecat's flag."""
    from daily import Daily
    from pipecat.transports.daily.transport import DailyTransportClient

    if not DailyTransportClient._daily_initialized:
        DailyTransportClient._daily_initialized = True
        Daily.init()


class DailyTextRoom:
    """A Daily call client that publishes and subscribes to no media.

    daily-python calls its event handler on its own thread; every event is
    moved onto the event loop before anything reads it.
    """

    def __init__(
        self,
        *,
        way_in: DailyWayIn,
        events: RoomEvents,
        quotable: Callable[[str], str],
    ) -> None:
        self._way_in = way_in
        self._events = events
        self._quotable = quotable
        self._client: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._leaving = False
        self._left_tasks: set[asyncio.Task[None]] = set()
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self.fault: str | None = None

    async def join(self, within: float) -> None:
        """Enter the room, publishing nothing."""
        from daily import CallClient, EventHandler

        _initialize_daily()
        loop = asyncio.get_running_loop()
        self._loop = loop
        room = self

        class _Events(EventHandler):
            def on_participant_joined(self, participant: Any) -> None:
                room._soon(room._participant, participant)

            def on_participant_updated(self, participant: Any) -> None:
                room._soon(room._participant, participant)

            def on_participant_left(self, participant: Any, _reason: Any) -> None:
                room._soon(room._participant_left, participant)

            def on_app_message(self, message: Any, sender: Any) -> None:
                room._soon(room._message, message, sender)

            def on_call_state_updated(self, state: Any) -> None:
                room._soon(room._call_state, state)

            def on_error(self, message: Any) -> None:
                room._soon(room._error, message)

        client = CallClient(event_handler=_Events())
        self._client = client
        client.update_subscription_profiles(
            {
                "base": {
                    "camera": "unsubscribed",
                    "microphone": "unsubscribed",
                    "screenVideo": "unsubscribed",
                    "screenAudio": "unsubscribed",
                }
            }
        )
        client.set_user_name(PERSONA_NAME)
        joined = loop.create_future()
        client.join(
            self._way_in.room_url,
            self._way_in.token,
            client_settings={"inputs": {"camera": False, "microphone": False}},
            completion=self._completion(joined),
        )
        try:
            data, error = await asyncio.wait_for(joined, timeout=max(0.0, within))
        except TimeoutError as slow:
            raise MediaBackendError(
                f"Egma could not join the Daily room within {within:.0f}s",
                ending=ERROR,
            ) from slow
        if error:
            raise MediaBackendError(
                f"Egma could not join the Daily room: {self._quotable(str(error))}",
                ending=ERROR,
            )
        self._events.joined(data if isinstance(data, dict) else {})
        for key, participant in client.participants().items():
            if key != "local" and isinstance(participant, dict):
                self._events.participant(participant)

    def _soon(self, handler: Callable[..., Any], *args: Any) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(handler, *args)

    def _completion(self, future: asyncio.Future[Any]) -> Callable[..., None]:
        def done(*args: Any) -> None:
            def settle() -> None:
                if not future.done():
                    future.set_result(args if len(args) != 1 else args[0])

            self._soon(settle)

        return done

    def _participant(self, participant: Any) -> None:
        if isinstance(participant, dict):
            self._events.participant(participant)

    def _participant_left(self, participant: Any) -> None:
        if self._leaving or not isinstance(participant, dict):
            return
        participant_id = participant.get("id")
        if isinstance(participant_id, str):
            task = asyncio.ensure_future(self._events.left(participant_id))
            self._left_tasks.add(task)
            task.add_done_callback(self._left_tasks.discard)

    def _message(self, message: Any, sender: Any) -> None:
        self._events.message(message, sender if isinstance(sender, str) else None)

    def _call_state(self, state: Any) -> None:
        if state == "left" and not self._leaving and not self.ended.is_set():
            self.failed.set()

    def _error(self, message: Any) -> None:
        if not self._leaving:
            logger.warning(
                "the Daily call reported an error: %s", self._quotable(str(message))
            )
            self.failed.set()

    async def send(self, message: Mapping[str, Any]) -> None:
        """Send one app message to everyone in the room."""
        client = self._client
        loop = self._loop
        if client is None or loop is None:
            raise MediaBackendError("a message was sent before the room existed")
        sent = loop.create_future()
        client.send_app_message(dict(message), None, completion=self._completion(sent))
        error = await asyncio.wait_for(sent, timeout=JOIN_SECONDS)
        if error:
            raise MediaBackendError(
                "Egma could not send a message in the Daily room: "
                f"{self._quotable(str(error))}",
                ending=ERROR,
            )

    async def leave(self) -> None:
        """Leave and release the call client; safe from every state."""
        client, self._client = self._client, None
        self._leaving = True
        self.ended.set()
        for task in list(self._left_tasks):
            task.cancel()
        if client is None:
            return
        loop = self._loop
        if loop is not None:
            left = loop.create_future()
            try:
                client.leave(completion=self._completion(left))
                await asyncio.wait_for(left, timeout=5.0)
            except Exception:
                logger.info("the Daily call did not confirm leaving")
        with contextlib.suppress(Exception):
            await asyncio.to_thread(client.release)


# -- Chat turns ----------------------------------------------------------------------


@dataclass
class _Run:
    """One LLM response of the bot, owned by the turn current when it started."""

    turn: int
    text: list[str] = field(default_factory=list)
    stopped: bool = False


@dataclass(frozen=True)
class RtviTurn:
    """Everything the bot wrote between two persona turns."""

    text: str | None
    ended: bool
    answer_began_at: float | None = None


QUIET_SECONDS = 3.0
"""Turn end when a finished tool call starts no new completion (run_llm=False,
a Flows NO_RESPONSE), or when a turn has no text yet: this long without an RTVI
event from the bot."""

SPEECH_WAIT_SECONDS = 60.0
"""Longest wait for bot-stopped-speaking after bot-started-speaking."""


class RtviTurns:
    """Assembles the bot's chat answers from RTVI events.

    Calls in flight are counted from llm-function-call-started, whose data is
    empty at Pipecat's default report level; a call leaves on its
    llm-function-call-stopped. A turn is over when a bot-llm-stopped arrived
    after the last llm-function-call-stopped, no call is in flight, and the turn
    has text; otherwise it ends after QUIET_SECONDS without a bot event. The
    reply is the turn's bot-llm-text tokens, sent whether or not it is spoken.

    A bot that speaks in chat (an SDK that did not turn speech off) is heard
    out to bot-stopped-speaking before the turn ends, so the next send-text
    does not interrupt it and cut the bot's own record of its answer.
    """

    def __init__(self) -> None:
        self.changed = asyncio.Event()
        self.turn = 0
        self._runs: list[_Run] = []
        self._open: _Run | None = None
        self._calls_in_flight = 0
        self._stopped_after_calls = True
        self._last_stop_at = 0.0
        self._last_event_at = 0.0
        self._answer_began: dict[int, float] = {}
        self._sent_ids: set[str] = set()
        self._speaking = False
        self._speech_began_at = 0.0
        self.refusal: str | None = None

    def begin_turn(self, message_id: str) -> int:
        self.turn += 1
        self._sent_ids.add(message_id)
        self._stopped_after_calls = True
        return self.turn

    def feed(self, message: Any) -> None:
        kind = _rtvi_type(message)
        if kind is None or kind == "bot-interrupted":
            return
        now = asyncio.get_running_loop().time()
        data = _rtvi_data(message)
        self._last_event_at = now
        if kind == "bot-llm-started":
            self._open = _Run(turn=self.turn)
            self._runs.append(self._open)
        elif kind == "bot-llm-text":
            text = data.get("text")
            run = self._open
            if run is None:
                run = _Run(turn=self.turn)
                self._runs.append(run)
                self._open = run
            if isinstance(text, str) and text:
                run.text.append(text)
                self._answer_began.setdefault(run.turn, now)
        elif kind == "bot-llm-stopped":
            if self._open is not None:
                self._open.stopped = True
                self._open = None
            self._stopped_after_calls = True
            self._last_stop_at = now
        elif kind == "llm-function-call-started":
            self._calls_in_flight += 1
        elif kind == "llm-function-call-stopped":
            self._calls_in_flight = max(0, self._calls_in_flight - 1)
            self._stopped_after_calls = False
        elif kind == "bot-started-speaking":
            self._speaking = True
            self._speech_began_at = now
        elif kind == "bot-stopped-speaking":
            self._speaking = False
        elif kind == "error-response" and message.get("id") in self._sent_ids:
            error = data.get("error")
            self.refusal = str(error) if error is not None else "no reason given"
        self.changed.set()

    def runs_of(self, turn: int, since: int = 0) -> list[_Run]:
        """The model runs a turn started, from its ``since``-th on."""
        return [run for run in self._runs if run.turn == turn][since:]

    def started(self, turn: int, since: int = 0) -> bool:
        return bool(self.runs_of(turn, since))

    def over_at(self, turn: int, since: int = 0) -> float | None:
        """When the turn ends if nothing else happens, or None while it cannot."""
        runs = self.runs_of(turn, since)
        if not runs or any(not run.stopped for run in runs):
            return None
        if self._calls_in_flight:
            return None
        if self._speaking:
            return self._speech_began_at + SPEECH_WAIT_SECONDS
        said = any(run.text for run in runs)
        if self._stopped_after_calls and said:
            return self._last_stop_at
        return self._last_event_at + QUIET_SECONDS

    def text_of(self, turn: int, since: int = 0) -> str | None:
        said = ["".join(run.text).strip() for run in self.runs_of(turn, since)]
        joined = "\n".join(text for text in said if text)
        return joined or None

    def answer_began_at(self, turn: int) -> float | None:
        return self._answer_began.get(turn)


# -- The lifecycle ---------------------------------------------------------------------


class PipecatRoomLifecycle:
    """Per-simulation start request, room join, readiness, and cleanup."""

    MODALITY: str

    def __init__(
        self,
        *,
        settings: StartSettings,
        simulation_id: str,
        max_duration_seconds: float,
        body_params: Mapping[str, Any] | None = None,
        on_provider_reference: Callable[[str], Awaitable[None]] | None = None,
        agent_report: AgentReportProbe | None = None,
        endpoint_resolver: Any = None,
    ) -> None:
        self._settings = settings
        self._simulation_id = simulation_id
        self._on_provider_reference = on_provider_reference
        self._agent_report = agent_report
        self._secrets = SecretRegistry()
        self._secrets.register(list(settings.secrets))
        self._starter = PipecatStarter(
            settings,
            simulation_id=simulation_id,
            body_params=body_params,
            max_duration_seconds=max_duration_seconds,
            secrets=self._secrets,
            modality=self.MODALITY,
            endpoint_resolver=endpoint_resolver,
        )
        self._startup = PipecatStartup()
        self._deadline: float | None = None
        self._room: Any = None
        self._report_task: asyncio.Task[None] | None = None
        self._client_ready_task: asyncio.Task[None] | None = None
        self._reference: str | None = None
        self._started = False
        self._fault: MediaBackendError | None = None

    @property
    def starter(self) -> PipecatStarter:
        return self._starter

    @property
    def startup(self) -> PipecatStartup:
        return self._startup

    @property
    def room(self) -> Any:
        return self._room

    @property
    def provider_reference(self) -> str | None:
        return self._reference

    def _quotable(self, told: str) -> str:
        return self._secrets.redact(told)[:200]

    def _room_events(self) -> RoomEvents:
        return RoomEvents(
            joined=self._joined,
            participant=self._participant,
            left=self._left,
            message=self._message,
            audio=self._startup.audio_arrived,
        )

    async def _way_in(self) -> DailyWayIn:
        """Register the reference, then send the start request."""
        if self._on_provider_reference is not None:
            await self._on_provider_reference(self._simulation_id)
        self._reference = self._simulation_id
        loop = asyncio.get_running_loop()
        self._deadline = loop.time() + PIPECAT_STARTUP_SECONDS
        self._report_task = asyncio.create_task(
            self._read_agent_report(),
            name=f"pipecat-agent-report:{self._simulation_id}",
        )
        return await self._starter.start(deadline=self._deadline)

    def _remaining(self) -> float:
        if self._deadline is None:
            return PIPECAT_STARTUP_SECONDS
        return max(0.0, self._deadline - asyncio.get_running_loop().time())

    async def _read_agent_report(self) -> None:
        """Poll Egma's server for the agent report until the simulation ends.

        Every second until the hello is accepted, then every two. A refused
        report at any time ends the simulation with the server's reason.
        """
        probe = self._agent_report
        if probe is None:
            return
        startup = self._startup
        while True:
            try:
                report = await probe()
            except asyncio.CancelledError:
                raise
            except AgentReportLost:
                if not self._started:
                    startup.report_lost = True
                    startup.changed.set()
                return
            except Exception as unread:
                logger.info(
                    "the agent report could not be read: %s",
                    self._quotable(repr(unread)),
                )
            else:
                if report.state == "refused":
                    startup.reported(report)
                    if self._started:
                        self._fail(
                            hello_refused_failure(report.code, report.message or "")
                        )
                    return
                if report.state == "accepted" and startup.report.state != "accepted":
                    startup.reported(report)
            await asyncio.sleep(
                AGENT_REPORT_WATCH_SECONDS
                if startup.report.state == "accepted"
                else AGENT_REPORT_POLL_SECONDS
            )

    def _fail(self, failure: MediaBackendError) -> None:
        """End a running simulation with the connection's own reason."""
        if self._fault is None:
            self._fault = failure
        room = self._room
        if room is not None:
            room.fault = str(self._fault)
            room.failed.set()

    # Room events.

    def _joined(self, data: Mapping[str, Any]) -> None:
        self._startup.joined(data)
        self._greet_the_bot()

    def _participant(self, participant: Mapping[str, Any]) -> None:
        self._startup.participant_seen(participant)
        self._greet_the_bot()

    def _message(self, message: Any, sender: str | None) -> bool:
        """Take one app message; True when it came from the bot."""
        startup = self._startup
        if startup.bot_id is None and sender not in (None, startup.local_id):
            # A message can be the first sign of the bot; its sender is the bot.
            self._participant({"id": sender})
        if not startup.from_bot(sender):
            return False
        startup.rtvi(message)
        return True

    async def _left(self, participant_id: str) -> None:
        self._startup.participant_left(participant_id)

    def _greet_the_bot(self) -> None:
        """Send client-ready once the persona has joined and the bot is present.

        A room message reaches only participants already present, and a message
        sent before the persona's own join completes is refused. Whichever of
        the two facts comes last sends it. It is never sent again: every
        client-ready runs the bot's on_client_ready handler.
        """
        startup = self._startup
        if (
            self._client_ready_task is None
            and startup.self_joined
            and startup.bot_id is not None
            and not startup.bot_left
        ):
            self._client_ready_task = asyncio.create_task(
                self._send_client_ready(), name="pipecat-client-ready"
            )

    async def _send_client_ready(self) -> None:
        """Send RTVI client-ready to the room."""
        room = self._room
        if room is None:
            return
        try:
            await room.send(client_ready_message())
        except asyncio.CancelledError:
            raise
        except Exception as unsent:
            logger.warning(
                "RTVI client-ready could not be sent: %s", self._quotable(repr(unsent))
            )

    # Readiness.

    async def wait_started(self) -> str:
        """Wait for the accepted hello, the bot, and its audio or bot-ready."""
        startup = self._startup
        room = self._room
        if room is None:
            raise MediaBackendError("a bot was waited for before a room")
        voice = self.MODALITY == "voice"
        try:
            while True:
                if startup.report.state == "refused":
                    raise hello_refused_failure(
                        startup.report.code, startup.report.message or ""
                    )
                if startup.report_lost:
                    raise MediaBackendError(
                        "Egma's server no longer lets this simulator hold the "
                        "simulation",
                        ending=ERROR,
                    )
                if startup.bot_left:
                    raise MediaBackendError(
                        "your bot left the Daily room before its startup finished",
                        ending=ERROR,
                    )
                if room.failed.is_set():
                    raise MediaBackendError(
                        "the Daily room closed while the bot was starting",
                        ending=ERROR,
                    )
                pending = startup.pending_condition(voice=voice)
                if pending == "ready":
                    break
                left = self._remaining()
                if left <= 0:
                    raise self._missing(pending, PIPECAT_STARTUP_SECONDS)
                startup.changed.clear()
                await first_of(startup.changed, room.failed, within=left)
        except MediaBackendError:
            self._log_startup("failed")
            raise
        self._started = True
        self._log_startup("ready")
        assert self._reference is not None
        return self._reference

    def _missing(self, pending: str, seconds: float) -> MediaBackendError:
        """The failure for the first missing startup fact."""
        startup = self._startup
        if pending == "hello_refused":
            return hello_refused_failure(
                startup.report.code, startup.report.message or ""
            )
        if pending == "bot_join":
            return never_joined_failure(
                seconds, pipecat_cloud=self._settings.pipecat_cloud
            )
        if pending == "egma_hello":
            return no_hello_failure(seconds)
        if pending == "rtvi_bot_ready":
            return rtvi_off_failure(seconds)
        return no_audio_failure(seconds)

    def startup_duration_failure(self, seconds: float) -> MediaBackendError:
        """Explain which startup fact was missing when the duration limit ended it."""
        self._log_startup("failed")
        if self._room is None and self._starter.attempts:
            return during_startup(self._starter.out_of_time(seconds), seconds)
        pending = self._startup.pending_condition(voice=self.MODALITY == "voice")
        if pending == "ready":
            return MediaBackendError(
                "Pipecat startup did not finish within the configured "
                f"{seconds:g}s duration",
                ending=ERROR,
            )
        return during_startup(self._missing(pending, seconds), seconds)

    def _log_startup(self, outcome: str) -> None:
        log_event(
            logger,
            logging.INFO if outcome == "ready" else logging.WARNING,
            f"egma.pipecat.startup_{outcome}",
            f"Pipecat startup {outcome}",
            attributes={
                "egma.startup.pending_condition": self._startup.pending_condition(
                    voice=self.MODALITY == "voice"
                ),
                "egma.pipecat.start_attempts": self._starter.attempts,
            },
        )

    async def _say_goodbye(self) -> None:
        """Ask an RTVI bot to end its session before the persona leaves."""
        room = self._room
        if room is None or self._startup.bot_left or not self._startup.bot_ready:
            return
        with contextlib.suppress(Exception):
            await asyncio.wait_for(room.send(rtvi_message("disconnect-bot")), 1.0)

    async def _stop_background(self) -> None:
        tasks = [
            task
            for task in (self._report_task, self._client_ready_task)
            if task is not None and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def teardown(self) -> None:
        """Leave the room; the starter owns the room and its expiry."""
        await self._stop_background()
        await self._say_goodbye()
        room, self._room = self._room, None
        if room is not None:
            await room.leave()


class PipecatVoiceBackend(PipecatRoomLifecycle):
    """A Pipecat bot heard through the Daily transport of the conductor's pipeline."""

    MODALITY = "voice"

    async def create_transport(self, *, audio_out_mixer: object = None) -> VoiceMedia:
        """Start the bot, then build the transport for the room it is in."""
        way_in = await self._way_in()
        self._room = self._joined_room(way_in)
        if audio_out_mixer is None:
            return self._room.create_transport()
        return self._room.create_transport(audio_out_mixer=audio_out_mixer)

    def _joined_room(self, way_in: DailyWayIn) -> Any:
        return DailyVoiceRoom(
            way_in=way_in, events=self._room_events(), quotable=self._quotable
        )

    async def dial(self) -> None:
        """Wait for the running transport to join the room."""
        room = self._room
        if room is None:
            raise MediaBackendError("a bot was dialled before a room transport")
        await room.wait_joined(min(JOIN_SECONDS, self._remaining()))

    async def _left(self, participant_id: str) -> None:
        if self._startup.participant_left(participant_id) and self._room is not None:
            await self._room.bot_departed()


class PipecatChatBackend(PipecatRoomLifecycle):
    """A Pipecat bot typed to over RTVI in a Daily room."""

    MODALITY = "chat"

    def __init__(self, **arguments: Any) -> None:
        super().__init__(**arguments)
        self._turns = RtviTurns()

    @property
    def turns(self) -> RtviTurns:
        return self._turns

    def _joined_room(self, way_in: DailyWayIn) -> Any:
        return DailyTextRoom(
            way_in=way_in, events=self._room_events(), quotable=self._quotable
        )

    def _message(self, message: Any, sender: str | None) -> bool:
        from_bot = super()._message(message, sender)
        if from_bot:
            self._turns.feed(message)
        return from_bot

    async def _left(self, participant_id: str) -> None:
        if self._startup.participant_left(participant_id):
            self._turns.changed.set()

    async def open_room(self) -> None:
        """Start the bot and join the room it is in."""
        way_in = await self._way_in()
        self._room = self._joined_room(way_in)
        await self._room.join(min(JOIN_SECONDS, self._remaining()))

    @property
    def has_ended(self) -> bool:
        room = self._room
        return room is not None and self._startup.bot_left and not room.failed.is_set()

    def raise_if_failed(self) -> None:
        if self._fault is not None:
            raise self._fault
        room = self._room
        if room is not None and room.failed.is_set():
            raise MediaBackendError(
                "the Daily room closed while the exchange was under way", ending=ERROR
            )

    async def wait_ended(self) -> None:
        if self._room is None:
            raise MediaBackendError("an ending was awaited before a room")
        startup = self._startup
        await startup.until(lambda: startup.bot_left, within=None)

    async def wait_failed(self) -> None:
        room = self._room
        if room is None:
            raise MediaBackendError("a failure was awaited before a room")
        await room.failed.wait()
        self.raise_if_failed()

    async def wait_greeting(self, seconds: float) -> RtviTurn:
        """The bot's opening words, or no text when it waits for the persona."""
        return await self._collect(0, first_within=seconds)

    async def deliver(self, text: str, *, reply_seconds: float) -> RtviTurn:
        """Send one persona turn with send-text and read the answer."""
        message = send_text_message(text)
        turn = self._turns.begin_turn(message["id"])
        await self._send(message)
        answer = await self._collect(turn, first_within=reply_seconds)
        if not answer.ended and not self._turns.started(turn):
            raise MediaBackendError(
                f"the bot answered nothing for {reply_seconds:.0f} seconds after "
                "the persona's turn. Egma stops here rather than ask again: a late "
                "answer could not be told from an answer to the next turn",
                ending=ERROR,
            )
        return answer

    async def listen(self, seconds: float) -> RtviTurn:
        """What the bot writes next without a persona turn."""
        turn = self._turns.turn
        return await self._collect(
            turn, first_within=seconds, since=len(self._turns.runs_of(turn))
        )

    async def send(self, text: str) -> None:
        """Send final persona words without waiting for an answer."""
        message = send_text_message(text)
        self._turns.begin_turn(message["id"])
        await self._send(message)

    async def _send(self, message: Mapping[str, Any]) -> None:
        room = self._room
        if room is None:
            raise MediaBackendError("a persona turn was delivered before a room")
        await room.send(message)

    async def _collect(
        self, turn: int, *, first_within: float, since: int = 0
    ) -> RtviTurn:
        """Wait for one turn's model runs to start and then to be over."""
        turns = self._turns
        room = self._room
        if room is None:
            raise MediaBackendError("an answer was read before a room")
        loop = asyncio.get_running_loop()
        first_deadline = loop.time() + first_within
        while True:
            self.raise_if_failed()
            if turns.refusal is not None:
                raise MediaBackendError(
                    "the bot refused Egma's RTVI send-text: "
                    f"{self._quotable(turns.refusal)}",
                    ending=ERROR,
                )
            if self._startup.bot_left:
                break
            now = loop.time()
            wake: float | None
            if not turns.started(turn, since):
                wake = first_deadline - now
                if wake <= 0:
                    return RtviTurn(text=None, ended=False)
            else:
                over_at = turns.over_at(turn, since)
                if over_at is not None and now >= over_at:
                    break
                wake = None if over_at is None else over_at - now
            turns.changed.clear()
            await first_of(
                turns.changed,
                room.failed,
                within=None if wake is None else max(0.0, wake),
            )
        return RtviTurn(
            text=turns.text_of(turn, since),
            ended=self._startup.bot_left,
            answer_began_at=turns.answer_began_at(turn) if since == 0 else None,
        )
