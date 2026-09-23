"""The mock-tool exchange with egma's server over HTTPS.

A Pipecat bot joins a Daily room that has no request-and-answer channel,
so the exchange LiveKit carries over in-room RPC travels to egma's server
instead. The messages are the in-room seam's (``egma.seam``): the same
protocol version, census, reply, tagged tool answer, refusal codes and
answer cap. HTTPS adds the route, the project API key, and the provider
reference that names the simulation.

Three routes, all ``POST`` with a JSON body and ``Authorization: Bearer
<project API key>``:

- ``/sdk/v1/hello``: the census; answers the names egma mocks.
- ``/sdk/v1/tool``: one call to a mocked tool; answers the tagged result.
- ``/sdk/v1/confirm``: whether a provider reference names a live simulation.

Only ``404`` with ``"error": "not_a_simulation"`` means "not a simulation".
Any other failure is a failure. The constants here are restated from, and
tested against, ``packages/simulation-contract/fixtures/seam/
sdk-https-exchange.v1.json``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import SplitResult, urlunsplit

import aiohttp

from .. import otlp, seam

logger = logging.getLogger("egma")

HELLO_ROUTE = "/sdk/v1/hello"
TOOL_ROUTE = "/sdk/v1/tool"
CONFIRM_ROUTE = "/sdk/v1/confirm"

HELLO_ATTEMPT_SECONDS = 10.0
"""The longest one hello attempt may take."""

HELLO_ATTEMPTS = 3
"""The most hello attempts one start makes."""

HELLO_ALL_ATTEMPTS_SECONDS = 30.0
"""The longest all hello attempts together may take."""

HELLO_RETRY_PAUSES_SECONDS = (1.0, 2.0)
"""The pause before the second and the third hello attempt."""

RETRYABLE_HELLO_STATUSES = frozenset({429, 502, 503, 504})
"""Statuses a hello is asked again for. Connection errors and timeouts too."""

TOOL_ATTEMPT_SECONDS = 10.0
"""The longest one mocked tool call to egma may take. A connection error
is asked once more; a timeout is not."""

CONFIRM_ATTEMPT_SECONDS = 5.0
"""The longest the one confirmation request may take."""

LARGEST_HELLO_REQUEST_BYTES = 256 * 1024
LARGEST_TOOL_REQUEST_BYTES = 64 * 1024
LARGEST_REPLY_BYTES = 64 * 1024
"""The most of an answer this side reads. egma's answers are far smaller."""

NOT_A_SIMULATION = "not_a_simulation"
"""The one ``error`` word that makes the SDK inert."""

FLOWS_FUNCTION_MOCKED = 905
"""egma's refusal code for a mocked Pipecat Flows function."""

_TRACE_SUFFIX = "/v1/traces"


class NotASimulation(Exception):
    """egma answered that the provider reference names no live simulation."""


class HelloFailed(Exception):
    """The hello was refused or not answered. ``reason`` says which, and how.

    ``verbatim`` is true when ``reason`` is egma's own sentence that is
    shown to the developer exactly as sent (the Flows refusal).
    """

    def __init__(self, reason: str, *, verbatim: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.verbatim = verbatim


@dataclass(frozen=True)
class _Reply:
    status: int
    body: bytes

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json_object(self) -> dict[str, Any] | None:
        try:
            value = json.loads(self.body)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def error_word(self) -> str:
        answered = self.json_object() or {}
        word = answered.get("error")
        return word if isinstance(word, str) else ""

    def refusal(self) -> str:
        """The server's refusal as one clause: status, code and message."""
        answered = self.json_object() or {}
        message = answered.get("message")
        code = answered.get("code")
        said = f"HTTP {self.status}"
        if isinstance(code, int) and not isinstance(code, bool):
            said += f", code {code}"
        if isinstance(message, str) and message.strip():
            return f"{said}: {message.strip()}"
        return said


def sdk_base(value: str, verb: str) -> str:
    """``EGMA_URL`` as the base the SDK routes hang off.

    The same URL rules as the trace exporter. A trailing ``/`` and a
    trailing ``/v1/traces`` are removed, so either form of the setting works.
    """
    parsed = otlp.api_base(value, verb)
    path = parsed.path.rstrip("/")
    if path.endswith(_TRACE_SUFFIX):
        path = path[: -len(_TRACE_SUFFIX)].rstrip("/")
    return urlunsplit(
        SplitResult(
            scheme=parsed.scheme,
            netloc=parsed.netloc,
            path=path,
            query="",
            fragment="",
        )
    )


def _serialized(value: object) -> bytes:
    """Compact JSON in UTF-8, as the in-room seam writes it."""
    return json.dumps(
        value, separators=(",", ":"), default=str, ensure_ascii=False
    ).encode("utf-8")


def _transport_failure(broke: BaseException, seconds: float) -> str:
    """What went wrong on the way to egma, without the request's content."""
    if isinstance(broke, asyncio.TimeoutError):
        return f"no answer within {seconds:g} seconds"
    if isinstance(broke, aiohttp.ClientConnectorError):
        return f"the connection failed ({broke.os_error or broke})"
    return f"{type(broke).__name__}: {broke}" if str(broke) else type(broke).__name__


class Seam:
    """One bot's side of the HTTPS exchange, for one provider reference."""

    def __init__(self, base_url: str, api_key: str, provider_reference: str) -> None:
        self._base_url = base_url
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self.provider_reference = provider_reference
        self._client: aiohttp.ClientSession | None = None

    def _session(self) -> aiohttp.ClientSession:
        if self._client is None or self._client.closed:
            self._client = aiohttp.ClientSession()
        return self._client

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is not None and not client.closed:
            await client.close()

    async def _post(self, route: str, payload: bytes, seconds: float) -> _Reply:
        async with self._session().post(
            f"{self._base_url}{route}",
            data=payload,
            headers=self._headers,
            timeout=aiohttp.ClientTimeout(total=seconds),
            # A redirect would carry the project key somewhere egma did not
            # name, so it is a failure rather than a place to go.
            allow_redirects=False,
        ) as response:
            # Read to the end, but never more than the cap: an oversized
            # answer is cut, fails to parse, and is treated as unreadable.
            chunks: list[bytes] = []
            received = 0
            while received <= LARGEST_REPLY_BYTES:
                chunk = await response.content.read(LARGEST_REPLY_BYTES + 1 - received)
                if not chunk:
                    break
                chunks.append(chunk)
                received += len(chunk)
            return _Reply(status=response.status, body=b"".join(chunks))

    async def hello(self, census: list[dict[str, Any]]) -> tuple[str, ...]:
        """Report the census; return the names egma answers for.

        Raises ``NotASimulation`` for egma's "not a simulation" answer and
        ``HelloFailed`` for every other answer that is not ``200``.
        """
        payload = _serialized(
            {
                "provider_reference": self.provider_reference,
                "protocol_version": seam.PROTOCOL_VERSION,
                "tools": census,
            }
        )
        if len(payload) > LARGEST_HELLO_REQUEST_BYTES:
            raise HelloFailed(
                f"this bot's tools are {len(payload)} bytes as a report, and "
                f"egma accepts at most {LARGEST_HELLO_REQUEST_BYTES}"
            )

        loop = asyncio.get_running_loop()
        deadline = loop.time() + HELLO_ALL_ATTEMPTS_SECONDS
        cause = ""
        for attempt in range(1, HELLO_ATTEMPTS + 1):
            seconds = min(HELLO_ATTEMPT_SECONDS, max(deadline - loop.time(), 0.001))
            try:
                reply = await self._post(HELLO_ROUTE, payload, seconds)
            except (TimeoutError, aiohttp.ClientError, OSError) as broke:
                cause = _transport_failure(broke, seconds)
            else:
                if reply.status == 200:
                    try:
                        return seam.mocked_tools_in(reply.text())
                    except seam.SeamError as unreadable:
                        raise HelloFailed(
                            f"egma answered in a shape this SDK cannot read "
                            f"({unreadable})"
                        ) from unreadable
                if reply.status == 404 and reply.error_word() == NOT_A_SIMULATION:
                    raise NotASimulation(reply.refusal())
                answered = reply.json_object() or {}
                if (
                    reply.status == 422
                    and answered.get("code") == FLOWS_FUNCTION_MOCKED
                    and isinstance(answered.get("message"), str)
                ):
                    raise HelloFailed(answered["message"], verbatim=True)
                if reply.status not in RETRYABLE_HELLO_STATUSES:
                    raise HelloFailed(f"egma refused the report ({reply.refusal()})")
                cause = reply.refusal()

            if attempt == HELLO_ATTEMPTS:
                break
            pause = HELLO_RETRY_PAUSES_SECONDS[
                min(attempt - 1, len(HELLO_RETRY_PAUSES_SECONDS) - 1)
            ]
            if loop.time() + pause >= deadline:
                break
            logger.debug("egma did not answer the hello (%s); asking again", cause)
            await asyncio.sleep(pause)
        raise HelloFailed(f"egma did not answer the report ({cause})")

    async def tool(
        self, name: str, arguments: dict[str, Any] | None, *, flows: bool
    ) -> seam.Served:
        """Ask egma to answer one call to a mocked tool.

        Never raises for an unanswered call: the result is a failure whose
        message says the real tool did not run.
        """
        asking: dict[str, Any] = {
            "provider_reference": self.provider_reference,
            "name": name,
        }
        if arguments is not None:
            asking["arguments"] = arguments
        if flows:
            asking["flows"] = True
        payload = _serialized(asking)

        cause = ""
        if len(payload) > LARGEST_TOOL_REQUEST_BYTES:
            cause = (
                f"the call is {len(payload)} bytes, and egma accepts at most "
                f"{LARGEST_TOOL_REQUEST_BYTES}"
            )
        else:
            for attempt in (1, 2):
                try:
                    reply = await self._post(TOOL_ROUTE, payload, TOOL_ATTEMPT_SECONDS)
                except TimeoutError as broke:
                    cause = _transport_failure(broke, TOOL_ATTEMPT_SECONDS)
                    break
                except (aiohttp.ClientConnectionError, OSError) as broke:
                    cause = _transport_failure(broke, TOOL_ATTEMPT_SECONDS)
                    if attempt == 1:
                        continue
                    break
                except aiohttp.ClientError as broke:
                    cause = _transport_failure(broke, TOOL_ATTEMPT_SECONDS)
                    break
                if reply.status == 200:
                    try:
                        return seam.served_in(reply.text())
                    except seam.SeamError as unreadable:
                        cause = f"egma's answer could not be read ({unreadable})"
                        break
                answered = reply.json_object() or {}
                message = answered.get("message")
                cause = (
                    message.strip()
                    if isinstance(message, str) and message.strip()
                    else f"HTTP {reply.status}"
                )
                break
        logger.warning("egma could not answer the mocked tool %r: %s", name, cause)
        return seam.Served(
            failed=True,
            message=(
                f'Egma could not answer the mocked tool "{name}": {cause}. '
                "The real tool did not run."
            ),
        )

    async def confirm(self) -> bool:
        """Whether egma confirms the provider reference names a live simulation.

        One attempt. Anything but ``200 {"simulation": true}`` is "not
        confirmed", which the caller treats as production.
        """
        payload = _serialized({"provider_reference": self.provider_reference})
        try:
            reply = await self._post(CONFIRM_ROUTE, payload, CONFIRM_ATTEMPT_SECONDS)
        except (TimeoutError, aiohttp.ClientError, OSError) as broke:
            logger.info(
                "egma could not confirm simulation %s (%s)",
                self.provider_reference,
                _transport_failure(broke, CONFIRM_ATTEMPT_SECONDS),
            )
            return False
        answered = reply.json_object() or {}
        return reply.status == 200 and answered.get("simulation") is True
