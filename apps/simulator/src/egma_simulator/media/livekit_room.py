"""Shared LiveKit room lifecycle for voice and chat simulations.

WayIn selects token authority:
- Project credentials: create and name a room, sign its token, explicitly
  dispatch agentName, then delete the room during teardown.
- Token endpoint: request a named room and participant over HTTPS, including
  agentName and test-owned dispatch metadata in room_config. The endpoint must
  copy the dispatch into its token. Egma leaves; the customer owns room expiry.
- Given token: join the platform-created room once. The platform owns dispatch
  and deletion; Egma does not invent a room ID.

RoomLifecycle handles setup, RPC registration, dispatch, and cleanup. Voice uses
Pipecat and waits for agent audio; chat uses text streams and waits for words.
Configuration comes from the connection, not the simulator environment.

Dispatch metadata contains only the test's job_dispatch_metadata as JSON,
or an empty string. Room metadata stays empty. Do not add scenario text, persona
instructions, expected behavior, or mock answers to agent-visible metadata.
Egma-created room names select simulation and modality; participant identity
addresses mock-tool RPC. These names alone are not proof of authentication.

Register hello and tool RPC at join time, including when no tools are mocked.
The SDK must complete hello before starting. Missing agents produce
AGENT_NEVER_JOINED; connection and setup faults produce ERROR.
Redact connection credentials and tokens from platform errors.
LiveKit imports remain lazy so non-room simulations do not load the library.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from operator import attrgetter
from typing import Any
from urllib.parse import urlsplit

from ..contract import AGENT_NEVER_JOINED, ERROR
from ..mock_tools import (
    HELLO_METHOD,
    TOOL_METHOD,
    MockToolSeam,
)
from ..platform_logging import log_event
from ..redaction import SecretRegistry
from . import MediaBackendError, VoiceMedia
from .room import (
    PERSONA_IDENTITY,
    QUOTED_REFUSAL_CHARS,
    JoinedRoom,
    RpcMethod,
    RpcNotice,
    RpcRefusalNotice,
    answering,
    chat_room_name_for,
    delete_room,
    disconnect_reason_name,
    first_of,
    fresh_chat_room_name,
    fresh_room_name,
    persona_name_for,
    room_name_for,
    room_token,
    room_was_deleted,
)

logger = logging.getLogger(__name__)

KNOWN_CONFIG_KEYS = frozenset({"url", "agentName"})
KNOWN_CREDENTIAL_KEYS = frozenset({"apiKey", "apiSecret"})
URL_SCHEMES = ("ws://", "wss://", "http://", "https://")

SERVER_URL_SCHEMES = ("wss://", "https://")
"""What a server named by a token endpoint's answer may start with.

Narrower than :data:`URL_SCHEMES` on purpose. A stored ``url`` is the
customer's own, written by someone who can see their server, and a
self-hosted LiveKit on a private ``ws://`` address is theirs to name. A
``server_url`` arrives at simulation time from whatever answered the
endpoint, and it decides where the just-minted token is sent next — so it
crosses the network under TLS or not at all.
"""

ENDPOINT_CONFIG_KEYS = frozenset({"tokenEndpoint", "agentName"})
"""Token-endpoint config requires the endpoint and agentName, not a server URL.
The reply supplies server_url and participant_token. Request room_config carries
the named worker and test-owned dispatch metadata for inclusion in the token.
"""

ENDPOINT_CREDENTIAL_KEYS = frozenset({"headers"})
PLATFORM_NAMED_ROOM = "the room the platform opened"
"""Log description for a platform-created room whose name is unknown.
This is not an identifier; the adapter supplies the platform provider_reference.
"""

ENDPOINT_SCHEME = "https://"

TOKEN_ALIASES = (
    "participant_token",
    "participantToken",
    "token",
    "accessToken",
    "access_token",
)
"""The names a minted token comes back under.

``participant_token`` is LiveKit's own: the standard token endpoint answers
``server_url`` and ``participant_token``, and every LiveKit client SDK reads
those. The rest are accepted because they are in the wild — teams that
already run a token endpoint for their own web client should be able to
point egma at the one they have rather than write a second one for egma.
The first of these that carries a string is the token.
"""

SERVER_URL_ALIASES = ("server_url", "serverUrl")
"""The names the LiveKit server comes back under: LiveKit's own, and the
lowerCamelCase spelling its protobuf JSON also admits. One of them is
required — the connection holds no server of its own to fall back on."""

TOKEN_SECONDS = 20.0
"""How long the endpoint has to answer before it counts as unreachable.

Short of the wait for the agent itself, so a slow endpoint reads as a slow
endpoint rather than as a worker that never came.
"""

TOKEN_RESPONSE_BYTES = 64 * 1024
"""The most token-endpoint data read into the simulator."""

CHAT_TOPIC = "lk.chat"
"""The text-stream topic a persona's turn is typed onto.

LiveKit's own agent session watches this topic for its linked
participant and treats whatever arrives as the person speaking, which is
why a chat simulation needs nothing installed in the agent to be *heard*.
"""

TRANSCRIPTION_TOPIC = "lk.transcription"
"""Agent text-stream topic. Closing a stream ends an utterance, not a whole turn.
Agent state and stream draining determine turn completion in take_turn().
"""

AGENT_STATE_ATTRIBUTE = "lk.agent.state"
"""Agent state attribute used to detect turn completion after first output.
React to arrival of a finished state; fast transitions can coalesce, so do not
require observing thinking or speaking first.

Keep the quiet fallback for agents without this attribute and realtime agents
whose SDK does not publish a finished state with audio output disabled.
These SDK paths were source-inspected; that is not live-wire verification.
"""

AGENT_FINISHED_STATES = frozenset({"listening", "idle"})
"""The states that mean the agent has finished the turn it was taking.

``listening`` is where a session sits between turns and ``idle`` where it
sits when nothing is listening at all. Every other state is the agent
still working, and that includes the whole of a tool call: the SDK moves a
turn from ``speaking`` to ``thinking`` when a tool returns output rather
than back to ``listening``, so a filler, a tool call and the answer out of
it stay one turn on this channel as they are on the other one.
"""

AGENT_INITIALIZED_STATES = frozenset({"listening", "thinking", "speaking"})
"""LiveKit session states that prove the worker finished session startup.

The SDK configuration exchange completes before ``session.start``. The first
``listening`` update can be overtaken by an immediate greeting, so thinking and
speaking are equally strong proof that the session can receive input.
"""

SPOKEN_TRACK_ATTRIBUTE = "lk.transcribed_track_id"
"""The stream attribute that means these words were spoken, not typed.

LiveKit sets it only where the text is synchronised to a published audio
track — so its presence is the wire itself saying the agent is talking.
That is one of the two facts that catch an agent which has not taken the
chat setup; the other is the track.
"""

STREAM_CLOSE_SECONDS = 1.0
"""How long a stream the agent closed on its way out may take to arrive.

A departing participant's last words and its departure reach egma through
one event queue, and the words are read in a task the departure does not
wait for. Without this the goodbye an agent leaves on would be dropped and
the record would show an agent that left saying nothing. Short, because
what is being waited for has already been sent.
"""


class _UnsafeEndpointAddress(OSError):
    """The token endpoint resolved to an address Egma must not reach."""


class LiveKitStartup:
    """Latched configuration and native session readiness for one worker.

    The participant that calls ``egma.hello`` is the worker under test. Native
    state from another room occupant cannot satisfy its startup.
    """

    def __init__(self, mock_tools: MockToolSeam | None) -> None:
        self._mock_tools = mock_tools
        self._changed = asyncio.Event()
        self._present: set[str] = set()
        self._seen: set[str] = set()
        self._states: dict[str, str] = {}
        self._audio_track_identities: set[str] = set()
        self._reporting_identity: str | None = None
        self._accepted_identity: str | None = None
        self._refusal: str | None = None
        self._registration_failure: str | None = None
        self._departed: set[str] = set()
        self._relevant_departure: str | None = None

    @staticmethod
    def _identity(invocation: Any) -> str:
        identity = getattr(invocation, "caller_identity", "")
        return identity if isinstance(identity, str) else ""

    def report_attempted(self, invocation: Any) -> None:
        identity = self._identity(invocation)
        if identity:
            self._reporting_identity = identity
        self._changed.set()

    def report_accepted(self, invocation: Any) -> None:
        identity = self._identity(invocation)
        if identity:
            self._accepted_identity = identity
        self._changed.set()

    def report_refused(self, _invocation: Any, _refused: object) -> None:
        if self._mock_tools is not None:
            self._refusal = self._mock_tools.why_unreported
        else:
            self._refusal = "the agent's Egma configuration was refused"
        self._changed.set()

    def registration_failed(self, reason: str) -> None:
        self._registration_failure = reason
        self._changed.set()

    def participant_seen(
        self, identity: str, attributes: dict[str, str] | None = None
    ) -> None:
        if not identity or identity == PERSONA_IDENTITY:
            return
        self._present.add(identity)
        self._seen.add(identity)
        if self._relevant_departure != identity:
            self._departed.discard(identity)
        if attributes is not None:
            self.participant_state(identity, attributes.get(AGENT_STATE_ATTRIBUTE))
        self._changed.set()

    def participant_state(self, identity: str, state: object) -> None:
        if (
            not identity
            or identity == PERSONA_IDENTITY
            or not isinstance(state, str)
        ):
            return
        self._present.add(identity)
        self._seen.add(identity)
        self._states[identity] = state
        self._changed.set()

    def participant_audio_track(self, identity: str) -> None:
        """Record an inbound audio track subscribed for this participant."""
        if not identity or identity == PERSONA_IDENTITY:
            return
        self._audio_track_identities.add(identity)
        self._changed.set()

    def participant_audio_track_left(self, identity: str) -> None:
        """Clear readiness when the participant has no subscribed audio track."""
        self._audio_track_identities.discard(identity)
        self._changed.set()

    def participant_left(self, identity: str) -> None:
        if not identity or identity == PERSONA_IDENTITY:
            return
        if self.is_relevant(identity):
            self._relevant_departure = identity
        self._present.discard(identity)
        self._states.pop(identity, None)
        self._audio_track_identities.discard(identity)
        self._departed.add(identity)
        self._changed.set()

    def is_relevant(self, identity: str) -> bool:
        if self._mock_tools is None:
            return True
        selected = self._accepted_identity or self._reporting_identity
        return selected is not None and identity == selected

    @property
    def ready(self) -> bool:
        identity = self._accepted_identity
        if self._mock_tools is None:
            return any(
                identity in self._present and state in AGENT_INITIALIZED_STATES
                for identity, state in self._states.items()
            )
        return (
            identity is not None
            and identity in self._present
            and self._states.get(identity) in AGENT_INITIALIZED_STATES
        )

    def _has_audio(self, room: Any) -> bool:
        if self._mock_tools is None:
            return bool(self._audio_track_identities)
        identity = self._accepted_identity
        return identity is not None and identity in self._audio_track_identities

    @property
    def no_participant_seen(self) -> bool:
        return not self._seen and self._reporting_identity is None

    async def wait(self, room: Any, *, require_audio: bool = False) -> None:
        """Wait for startup or an explicit room/configuration failure.

        There is no local deadline. The simulation's outer control cancels this
        await when its configured duration or cancel directive wins.
        """
        while True:
            refusal = self._refusal
            identity = self._accepted_identity or self._reporting_identity
            if self._registration_failure is not None:
                raise MediaBackendError(self._registration_failure, ending=ERROR)
            if refusal is not None:
                raise MediaBackendError(refusal, ending=ERROR)
            if self._relevant_departure is not None or (
                identity is not None and identity in self._departed
            ):
                raise MediaBackendError(
                    "the agent disconnected before its LiveKit session finished "
                    "starting",
                    ending=ERROR,
                )
            if room.failed.is_set():
                raise MediaBackendError(
                    f"the livekit server at {self._server(room)} closed the room "
                    "while the agent's session was starting",
                    ending=ERROR,
                )
            if room.ended.is_set():
                raise MediaBackendError(
                    "the agent disconnected before its LiveKit session finished "
                    "starting",
                    ending=ERROR,
                )
            has_audio = not require_audio or self._has_audio(room)
            if self.ready and has_audio:
                return

            self._changed.clear()
            waiting = [
                asyncio.ensure_future(self._changed.wait()),
                asyncio.ensure_future(room.failed.wait()),
                asyncio.ensure_future(room.ended.wait()),
            ]
            if (
                require_audio
                and self._mock_tools is None
                and not room.carrying_audio.is_set()
            ):
                waiting.append(asyncio.ensure_future(room.carrying_audio.wait()))
            try:
                await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for unfinished in waiting:
                    if not unfinished.done():
                        unfinished.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await unfinished

    def duration_failure(self, seconds: float, *, require_audio: bool = False) -> str:
        """Explain which startup condition was absent at the outer duration."""
        duration = f"{seconds:g}s"
        if not self._present and self._reporting_identity is None:
            return (
                f"no agent joined before the simulation's configured {duration} "
                "duration expired"
            )
        if self._accepted_identity is None:
            why = (
                self._mock_tools.why_unreported
                if self._mock_tools is not None
                else "the agent did not complete Egma configuration"
            )
            return f"{why}; the configured {duration} simulation duration expired"
        state = self._states.get(self._accepted_identity)
        if state not in AGENT_INITIALIZED_STATES:
            return (
                "the agent reported to Egma, but its LiveKit session did not publish "
                "an initialized state before the simulation's configured "
                f"{duration} duration expired"
            )
        if require_audio and not self._has_audio_for_duration():
            return (
                "the agent's LiveKit session initialized, but its voice media path "
                "was not ready before the simulation's configured "
                f"{duration} duration expired"
            )
        return (
            "LiveKit startup did not finish within the configured "
            f"{duration} duration"
        )

    def _has_audio_for_duration(self) -> bool:
        identity = self._accepted_identity
        return identity is not None and identity in self._audio_track_identities

    @staticmethod
    def _server(room: Any) -> str:
        return getattr(room, "_url", "configured server")


def _public_endpoint_address(raw: object) -> None:
    """Refuse every address that is not globally routable."""
    if not isinstance(raw, str):
        raise _UnsafeEndpointAddress
    try:
        address = ipaddress.ip_address(raw)
    except ValueError as invalid:
        raise _UnsafeEndpointAddress from invalid
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if not address.is_global or address.is_multicast:
        raise _UnsafeEndpointAddress


def _unsafe_endpoint_failure(error: BaseException) -> bool:
    """Whether an HTTP-client wrapper carries an address-policy refusal."""
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending:
        held = pending.pop()
        if id(held) in seen:
            continue
        seen.add(id(held))
        if isinstance(held, _UnsafeEndpointAddress):
            return True
        for nested in (
            getattr(held, "os_error", None),
            held.__cause__,
            held.__context__,
        ):
            if isinstance(nested, BaseException):
                pending.append(nested)
    return False


class _EndpointResolver:
    """Check every DNS answer before aiohttp chooses one to connect to."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    async def resolve(
        self, host: str, port: int = 0, family: int = socket.AF_INET
    ) -> list[dict[str, Any]]:
        answers = await self._delegate.resolve(host, port, family)
        for answer in answers:
            _public_endpoint_address(answer.get("host"))
        return answers

    async def close(self) -> None:
        await self._delegate.close()


def _endpoint_socket(addr_info: tuple[Any, ...]) -> socket.socket:
    """Open only the exact public address the HTTP client selected.

    The check lives in the socket factory rather than in a separate DNS lookup.
    That makes the checked address and the connected address the same value,
    so changing DNS between two lookups cannot move the request onto a private
    network. The resolver check above rejects a mixed answer before the
    connector chooses one; this second check protects the final address too.
    """
    family, kind, protocol, _canonical_name, sockaddr = addr_info
    _public_endpoint_address(sockaddr[0])
    return socket.socket(family=family, type=kind, proto=protocol)


async def _token_body(answer: Any) -> bytes:
    """Read no more than one bounded token response plus one proof byte."""
    held = bytearray()
    async for chunk in answer.content.iter_chunked(16 * 1024):
        held.extend(chunk)
        if len(held) > TOKEN_RESPONSE_BYTES:
            return bytes(held[: TOKEN_RESPONSE_BYTES + 1])
    return bytes(held)


def platform_refusal(what_failed: str, code: str, told: str) -> MediaBackendError:
    """The platform said no, in the platform's own words.

    ``told`` is already scrubbed of this connection's secret by whoever
    quoted it: words repeated from somebody else are not the quoter's to
    trust. One sentence for every refusal of this shape, so what CI proves
    about a reason is proved about the one a customer will read.
    """
    return MediaBackendError(
        f"{what_failed}: livekit answered {code} — {told}", ending=ERROR
    )


def unreachable_refusal(what_failed: str, url: str, told: str) -> MediaBackendError:
    """Nothing answered at all — the other way a request to a room fails."""
    return MediaBackendError(
        f"{what_failed}: the livekit server at {url} could not be reached — "
        f"{told}",
        ending=ERROR,
    )


@dataclass(frozen=True)
class RoomSettings:
    """Room access settings for project credentials, token endpoint, or a given token.
    Unused fields stay empty; mints_its_own identifies local token creation.
    """

    url: str
    """The customer's LiveKit, ``ws``/``wss`` or ``http``/``https``.

    Empty on the shape that asks an endpoint for its token: that shape
    learns the server from the endpoint's answer, once per simulation, and
    holds no address of its own to prefer over it.
    """

    api_key: str = ""
    api_secret: str = field(default="", repr=False)

    agent_name: str = ""
    """Which agent to dispatch, by the name its worker registered under.

    Demanded on both shapes that come by their own token. Where egma holds
    the key pair it dispatches this worker itself; where it asks an endpoint
    it names this worker in the request's ``room_config``, and the endpoint
    dispatches by minting a token that carries it. Empty only on the shape
    that was handed a token for a room somebody else opened — see
    :meth:`from_connection`.
    """

    token_endpoint: str = ""
    """Where egma asks for a token, once per simulation. Empty on the
    shape that mints its own."""

    endpoint_headers: dict[str, str] = field(
        default_factory=dict, repr=False
    )
    """What egma sends to authenticate itself to that endpoint."""

    given_token: str = field(default="", repr=False)
    """A way into a room that somebody else already opened.

    Empty on both shapes that come by their own. Where it is set, the room
    exists before egma knows about it, ``url`` is the platform's own server
    rather than the customer's, and the token opens that one room for one
    join — so it is registered as the secret it is.
    """

    @property
    def mints_its_own(self) -> bool:
        """Whether egma holds the key pair that signs its own tokens.

        The whole difference between the shapes, asked once. Where it is
        false egma has a token and nothing else: no room to create, no
        worker to dispatch, and no room to delete when it is over.
        """
        return not (self.token_endpoint or self.given_token)

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret these settings hold, for redaction. One place to
        ask, so a second one arriving cannot fall out of the scrubbing.

        A header's whole value is the secret, not the part after the
        scheme: ``Bearer …`` is how it goes on the wire, and it is how an
        endpoint that echoes it back would print it.
        """
        return tuple(
            held
            for held in (
                self.api_secret,
                self.given_token,
                *self.endpoint_headers.values(),
            )
            if held
        )

    @classmethod
    def from_connection(
        cls, access_variant: str, config: dict[str, Any], credentials: Any
    ) -> RoomSettings:
        """Read one connection block, or refuse it in a sentence.

        Everything a room needs is here and nothing is looked up, which
        is what makes a connection that cannot be used an honest refusal
        before anything is reached rather than a failure part-way through
        an exchange.
        """
        if access_variant == "livekit_room.customer_token_endpoint":
            return cls._at_an_endpoint(config, credentials)
        if access_variant != "livekit_room.project_credentials":
            raise MediaBackendError(
                "the livekit-room adapter does not support access variant "
                f"{access_variant!r}"
            )
        if config.get("tokenEndpoint") is not None:
            raise MediaBackendError(
                "livekit project-credential access does not accept tokenEndpoint"
            )

        unknown = set(config) - KNOWN_CONFIG_KEYS
        if unknown:
            raise MediaBackendError(
                f"a livekit connection does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(KNOWN_CONFIG_KEYS)}"
            )

        url = _server_url(config)

        # Demanded rather than defaulted, and demanded here so that a
        # connection nobody can dispatch is a sentence before any request
        # leaves egma. Every egma dispatch is explicit: a room filled by
        # automatic dispatch goes to whichever workers are listening, so
        # the record could never say which agent it graded, and the test's
        # job dispatch metadata would have no dispatch to ride.
        agent_name = config.get("agentName")
        if not isinstance(agent_name, str) or not agent_name.strip():
            raise MediaBackendError(
                "livekit config: agentName must be a non-empty string — the "
                "name the agent's worker registered under, because Egma "
                "dispatches that worker by name for every simulation"
            )

        if not isinstance(credentials, dict):
            raise MediaBackendError(
                "a livekit connection reaches the customer's own livekit "
                "project, so it needs their apiKey and apiSecret"
            )
        stray = set(credentials) - KNOWN_CREDENTIAL_KEYS
        if stray:
            raise MediaBackendError(
                "a livekit connection carries the key pair that opens the "
                f"room and nothing else; {sorted(stray)} is read by nobody"
            )
        pair = {}
        for name in ("apiKey", "apiSecret"):
            value = credentials.get(name)
            if not isinstance(value, str) or not value.strip():
                # The value is never quoted back, whatever it turned out
                # to be: a refusal about a secret must not carry one.
                raise MediaBackendError(
                    f"livekit credentials: {name} must be a non-empty string"
                )
            pair[name] = value.strip()

        return cls(
            url=url,
            api_key=pair["apiKey"],
            api_secret=pair["apiSecret"],
            agent_name=agent_name.strip(),
        )

    @classmethod
    def _at_an_endpoint(
        cls, config: dict[str, Any], credentials: Any
    ) -> RoomSettings:
        """The shape whose config names where to ask for a token.

        Read strictly, and here rather than at token time: a connection
        that could never work is a sentence somebody can act on before a
        simulation starts, and a mystery once one has.
        """
        unknown = set(config) - ENDPOINT_CONFIG_KEYS
        if unknown:
            raise MediaBackendError(
                f"a livekit connection that names a tokenEndpoint learns the "
                f"server from that endpoint's answer and asks it to dispatch "
                f"the worker by name; config key(s) {sorted(unknown)} are read "
                f"by nobody. It knows {sorted(ENDPOINT_CONFIG_KEYS)}"
            )

        endpoint = config.get("tokenEndpoint")
        if not isinstance(endpoint, str) or not endpoint.strip():
            raise MediaBackendError(
                "livekit config: tokenEndpoint must be a non-empty string — "
                "where Egma asks the customer for a token"
            )
        endpoint = _token_endpoint_url(endpoint.strip())

        # Demanded for the same reason as on the key-pair shape, and here the
        # name is also what egma puts in the request: the endpoint is asked
        # for this worker, by name, in the token it mints.
        agent_name = config.get("agentName")
        if not isinstance(agent_name, str) or not agent_name.strip():
            raise MediaBackendError(
                "livekit config: agentName must be a non-empty string — the "
                "name the agent's worker registered under, because Egma asks "
                "your token endpoint to dispatch that worker by name for "
                "every simulation"
            )

        return cls(
            url="",
            agent_name=agent_name.strip(),
            token_endpoint=endpoint,
            endpoint_headers=_endpoint_headers(credentials),
        )


def _server_url(config: dict[str, Any]) -> str:
    """The livekit server both shapes are joined through."""
    url = config.get("url")
    if not isinstance(url, str) or not url.strip():
        raise MediaBackendError(
            "livekit config: url must be a non-empty string — the "
            "customer's own livekit server"
        )
    url = url.strip()
    if not url.startswith(URL_SCHEMES):
        raise MediaBackendError(
            f"livekit config: url must start with one of "
            f"{', '.join(URL_SCHEMES)}; got {url!r}"
        )
    return url


def _token_endpoint_url(endpoint: str) -> str:
    """A stored endpoint in a shape the network guard can enforce.

    The platform admits only public-looking HTTPS hostnames. This reader
    independently applies the same transport rule before an auth header or
    room token can cross the network. Permission to connect is decided later,
    against the exact socket address; parsing a URL is never permission to
    reach its host.
    """
    try:
        parsed = urlsplit(endpoint)
        hostname = parsed.hostname
        # Accessing ``port`` is itself validation: malformed values raise.
        _ = parsed.port
    except ValueError:
        parsed = None
        hostname = None

    if (
        parsed is None
        or not endpoint.lower().startswith(ENDPOINT_SCHEME)
        or parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise MediaBackendError(
            "livekit config: tokenEndpoint must be an https URL with "
            "a hostname, like https://example.com/egma/livekit-token"
        )
    return endpoint


def _server_host(server_url: str) -> tuple[str, int] | None:
    """The host and port a server url names, or None for one egma will not join.

    A TLS scheme, a hostname, no credentials in the url, and a port that
    parses: the reading :func:`_token_endpoint_url` gives a stored endpoint,
    applied to an address that arrived in an answer. Parsing is not
    permission to reach the host; that is decided against the addresses
    the host stands for, in :meth:`RoomLifecycle._joinable_server`.
    """
    try:
        parsed = urlsplit(server_url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (
        not server_url.lower().startswith(SERVER_URL_SCHEMES)
        or parsed.scheme not in ("wss", "https")
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    return hostname, port if port is not None else 443


def _unjoinable(endpoint: str, named: str) -> MediaBackendError:
    """The refusal for a server url egma will not send a token to."""
    return MediaBackendError(
        f"the token endpoint at {endpoint} answered a {named} Egma cannot "
        f"join: it must be a {' or '.join(SERVER_URL_SCHEMES)} URL naming a "
        f"host, because the token is sent there next and Egma sends it over "
        f"TLS only",
        ending=ERROR,
    )


def _endpoint_headers(credentials: Any) -> dict[str, str]:
    """What egma sends to authenticate itself to a token endpoint.

    Every endpoint is public, so every endpoint carries auth headers. A
    refusal names the field and never quotes the value, because the values are
    the credential.
    """
    if not isinstance(credentials, dict):
        raise MediaBackendError(
            "a livekit connection that names a tokenEndpoint needs that "
            "endpoint's auth headers under credentials.headers"
        )

    stray = set(credentials) - ENDPOINT_CREDENTIAL_KEYS
    if stray:
        raise MediaBackendError(
            "a livekit connection that names a tokenEndpoint holds no key "
            f"pair, only that endpoint's headers; {sorted(stray)} is read by "
            "nobody"
        )

    written = credentials.get("headers")
    held: Any = written
    if isinstance(written, str):
        try:
            held = json.loads(written)
        except ValueError:
            held = None

    if (
        not isinstance(held, dict)
        or not held
        or any(
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(value, str)
            or not value.strip()
            for name, value in held.items()
        )
    ):
        raise MediaBackendError(
            "livekit credentials: headers must be a JSON object of header "
            "name to header value"
        )
    return {name.strip(): value.strip() for name, value in held.items()}


@dataclass(frozen=True)
class WayIn:
    """A token and the server it opens — everything a join needs.

    The seam between the two shapes. Above it the exchange is one code
    path: joining, waiting, conducting and leaving do not care whether
    egma signed the token itself or was handed one.
    """

    url: str
    token: str = field(repr=False)


class RoomLifecycle:
    """Per-simulation room setup, token acquisition, mock RPC, dispatch, and cleanup.
    Subclasses supply voice or chat joining and answer handling.
    """

    MODALITY: str
    """Which kind of simulation this driver conducts.

    It is not decoration: it names the room. A chat driver's rooms carry
    the modality mark the customer's worker reads, and that mark is the
    only thing that tells an agent whether to answer in speech or in
    text. A subclass that conducts something else says so here, and the
    name tells the truth by construction rather than by a caller
    remembering to pass the right word.
    """

    def __init__(
        self,
        *,
        settings: RoomSettings,
        simulation_id: str,
        mock_tools: MockToolSeam | None = None,
        job_dispatch_metadata: dict[str, Any] | None = None,
        endpoint_resolver: Any = None,
        confirm_remote_end: Callable[[], Awaitable[bool]] | None = None,
        on_provider_reference: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self._settings = settings
        self._mock_tools = mock_tools
        self._startup = LiveKitStartup(mock_tools)
        self._endpoint_resolver = endpoint_resolver
        self._confirm_remote_end = confirm_remote_end
        self._on_provider_reference = on_provider_reference
        # Written out once, here, rather than at the dispatch: the string
        # is what goes on the wire, and one serialisation means there is
        # no second spelling of the test's object to disagree with the
        # first. Compact and not ASCII-escaped, which is the same form the
        # control plane measured the platform's 512 KiB ceiling on, so a
        # value that saved cannot fail here for being too large.
        self._dispatch_metadata = (
            ""
            if job_dispatch_metadata is None
            else json.dumps(
                job_dispatch_metadata, separators=(",", ":"), ensure_ascii=False
            )
        )
        # One registry per driver, so what this driver quotes from the
        # platform goes through the same scrubbing a log line does rather
        # than through a second implementation of it.
        self._secrets = SecretRegistry()
        self._secrets.register(list(settings.secrets))
        # Use a simulation room name with the chat modality prefix where applicable.
        # A platform-provided token already selects a room; do not invent its identity.
        self._room_name = (
            PLATFORM_NAMED_ROOM
            if settings.given_token
            else self._fresh_room_name()
            if settings.mints_its_own
            else self._room_name_for(simulation_id)
        )
        self._participant_name = persona_name_for(simulation_id)
        self._room: Any = None
        self._server_url = ""
        """The server the join went to, once there was one: the connection's
        own url, or the one an endpoint's answer named."""
        self._asked_for_a_room = False
        self._offered = False
        self._offer_failure: str | None = None

    @property
    def room_name(self) -> str:
        """The room this exchange is conducted in — one room, one
        simulation, and what the report carries as the provider reference
        on the two shapes where egma named it. On the shape where a
        platform did, this is :data:`PLATFORM_NAMED_ROOM`: a description
        rather than a name, and the provider reference is the platform's
        own id for the exchange instead."""
        return self._room_name

    def _fresh_room_name(self) -> str:
        """What a room egma mints itself is called. The chat driver
        overrides this with the marked form, because the name is where a
        worker reads the modality from."""
        return fresh_room_name()

    def _room_name_for(self, simulation_id: str) -> str:
        """The room named after the simulation, where an endpoint is asked
        for a token into it: the bare form, which says voice."""
        return room_name_for(simulation_id)

    def _answer_for_mocked_tools(self) -> bool:
        """Register hello and tool RPC as soon as the room joins. dial() retries if
        needed.
        Mark setup complete only after both registrations succeed. Register even with
        no mock tools: hello returns an empty list and records the agent tool inventory.
        Registration failures are logged here; simulation startup still requires hello.
        """
        if self._mock_tools is None or self._room is None or self._offered:
            return self._offered or self._mock_tools is None
        try:
            self._room.register_rpc(
                HELLO_METHOD,
                self._mock_tools.hello,
                on_attempt=self._startup.report_attempted,
                on_accepted=self._startup.report_accepted,
                on_refused=self._startup.report_refused,
            )
            self._room.register_rpc(TOOL_METHOD, self._mock_tools.tool)
        except Exception as unoffered:
            self._offer_failure = (
                f"Egma could not offer its configuration and mock-tool exchange "
                f"in {self._room_name}: {self._quotable(repr(unoffered))}"
            )
            logger.error(
                "Egma could not offer its configuration and mock-tool exchange "
                "in %s, so SDK setup cannot complete: %s",
                self._room_name,
                self._quotable(repr(unoffered)),
            )
            return False
        self._offered = True
        self._offer_failure = None
        return True

    async def wait_started(self, *, require_audio: bool = False) -> str:
        """Wait for the SDK exchange and the same participant's native session."""
        room = self._room
        if room is None:
            raise MediaBackendError("an agent was waited for before a room")
        await self._startup.wait(room, require_audio=require_audio)
        return self._room_name

    def startup_duration_failure(
        self, seconds: float, *, require_audio: bool = False
    ) -> str:
        if self._startup.no_participant_seen:
            return (
                f"{self._nobody_came(seconds)}; the simulation's configured "
                f"{seconds:g}s duration expired during startup"
            )
        return self._startup.duration_failure(seconds, require_audio=require_audio)

    async def _way_in(self) -> WayIn:
        """A token and a room, however this connection comes by them.

        Egma makes the room and signs its own token for it, or asks the
        customer's endpoint for one, or was handed one for a room a
        platform opened itself — and everything after this is the same
        whichever it was.
        """
        if self._on_provider_reference is not None:
            # The token endpoint may dispatch immediately. Persist the room
            # association before either it or CreateRoom can start a worker.
            await self._on_provider_reference(self._room_name)
        if self._settings.given_token:
            # Nothing is reached for here: the room is already open and the
            # way in was part of whatever opened it. One token, one join —
            # these are spent on use, so there is no second one to ask for.
            return WayIn(url=self._settings.url, token=self._settings.given_token)
        if not self._settings.mints_its_own:
            return await self._token_from_endpoint()

        # Noted before the request rather than after it: a room the server
        # made and could not say so about is still a room, and teardown
        # has to go and ask about it.
        self._asked_for_a_room = True
        await self._create_room()
        return WayIn(
            url=self._settings.url,
            token=room_token(
                self._settings.api_key, self._settings.api_secret, self._room_name
            ),
        )

    async def dial(self) -> None:
        """Dispatch the named worker only when Egma holds project credentials.
        Token endpoints and platforms own their dispatch. Check current participants
        before waiting because the agent may already have joined.
        """
        if self._room is None:
            raise MediaBackendError("an agent was requested before a room transport")
        await self._room.wait_connected()
        if not self._answer_for_mocked_tools():
            self._startup.registration_failed(
                self._offer_failure
                or "Egma could not offer its configuration and mock-tool exchange"
            )
        self._room.note_anybody_already_here()
        if not self._settings.mints_its_own:
            return
        await self._dispatch()

    async def _wait_arrivals(self, seconds: float) -> bool:
        """Whether anybody joined the room inside a legacy caller's budget."""
        room = self._room
        if room is None:
            raise MediaBackendError("an agent was waited for before a room")
        return await first_of(room.arrivals, within=seconds)

    async def teardown(self) -> None:
        """Leave on every ending and delete rooms created with project credentials.
        With endpoint or given tokens, room cleanup belongs to the token issuer.
        """
        room, self._room = self._room, None
        try:
            if room is not None:
                await room.leave()
        finally:
            if self._asked_for_a_room:
                await self._delete_room()

    # Network operations are grouped here for room test doubles.
    # Token-endpoint tests use a real local HTTP server to validate the request bytes.

    async def _create_room(self) -> None:
        """One `CreateRoom`, and it carries a name and nothing else.

        No metadata: what a simulation's agent is given belongs to the
        dispatch that puts that agent in this room, and a second copy on
        the room would be a second value to keep equal to the first.
        """
        from livekit import api

        await self._asked(
            api.CreateRoomRequest(name=self._room_name),
            "the room could not be created",
        )

    async def _dispatch(self) -> None:
        """One `CreateAgentDispatch`, carrying the test's own JSON."""
        from livekit import api

        request = api.CreateAgentDispatchRequest(
            room=self._room_name,
            agent_name=self._settings.agent_name,
            # The test's own ``job_dispatch_metadata``, and nothing of
            # egma's beside it: an agent reading its per-session context
            # out of the channel LiveKit teaches it to read finds the keys
            # this scenario wrote, so a worker doing
            # ``json.loads(ctx.job.metadata)["tenant"]`` keeps working
            # under test and reads a different tenant per scenario. Empty
            # where the test wrote none.
            metadata=self._dispatch_metadata,
        )
        await self._asked(
            request,
            f"the agent {self._settings.agent_name!r} could not be dispatched",
        )

    def _endpoint_connector(self, aiohttp: Any, resolver: Any) -> tuple[Any, Any]:
        """Build the guarded connector used for every token request.

        A caller can supply a resolver for a system-boundary test, but it
        still passes through the same policy before the connector can use it.
        """
        guarded = _EndpointResolver(resolver)
        connector = aiohttp.TCPConnector(
            resolver=guarded,
            socket_factory=_endpoint_socket,
            use_dns_cache=False,
        )
        return guarded, connector

    def _token_request(self) -> dict[str, Any]:
        """Build the token request with room and participant names plus one named
        dispatch.
        participant_name repeats participant_identity for endpoint compatibility.
        Dispatch metadata contains only the test-owned job_dispatch_metadata.
        Do not expose other test content through metadata or participant attributes.
        """
        dispatch: dict[str, str] = {"agent_name": self._settings.agent_name}
        if self._dispatch_metadata:
            dispatch["metadata"] = self._dispatch_metadata
        return {
            "room_name": self._room_name,
            "participant_identity": self._participant_name,
            "participant_name": self._participant_name,
            "room_config": {"agents": [dispatch]},
        }

    async def _token_from_endpoint(self) -> WayIn:
        """Request a token and server URL from the customer endpoint.
        The endpoint selects the server; the connection has no separate server address.
        Report status or contract errors without exposing response bodies or network
        exceptions.
        """
        import aiohttp

        endpoint = self._settings.token_endpoint
        asked = self._token_request()

        resolver = self._endpoint_resolver or aiohttp.resolver.DefaultResolver()
        try:
            resolver, connector = self._endpoint_connector(aiohttp, resolver)
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=TOKEN_SECONDS),
                connector=connector,
            ) as session, session.post(
                endpoint,
                json=asked,
                headers=self._settings.endpoint_headers,
                # A token endpoint answers; it does not send egma somewhere
                # else. Following a redirect would carry the customer's own
                # auth headers to a host they never configured, chosen by
                # whoever answered — so a redirect is read as the answer it
                # is, and only its status is reported.
                allow_redirects=False,
            ) as answer:
                status = answer.status
                said = (
                    await _token_body(answer)
                    if 200 <= status < 300
                    else b""
                )
        except Exception as unreachable:
            if _unsafe_endpoint_failure(unreachable):
                reason = (
                    f"the token endpoint at {endpoint} resolved to a non-public "
                    f"network address"
                )
            elif isinstance(unreachable, asyncio.TimeoutError):
                reason = (
                    f"the token endpoint at {endpoint} did not answer within "
                    f"{TOKEN_SECONDS:g} seconds"
                )
            elif isinstance(unreachable, (aiohttp.ClientError, OSError)):
                reason = (
                    f"the token endpoint at {endpoint} could not be reached "
                    f"over HTTPS"
                )
            else:
                raise
            raise MediaBackendError(reason, ending=ERROR) from unreachable
        finally:
            with contextlib.suppress(Exception):
                await resolver.close()

        if status < 200 or status >= 300:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered {status}",
                ending=ERROR,
            )
        if len(said) > TOKEN_RESPONSE_BYTES:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered more than "
                f"{TOKEN_RESPONSE_BYTES} bytes",
                ending=ERROR,
            )

        token, named, server_url = self._minted(endpoint, said)
        # The endpoint's answer is the only place the server is named: it
        # knows which of the customer's projects this agent lives in, and the
        # connection holds no url of its own to prefer over it. It is also an
        # address chosen by whoever answered, so it is held to the rule the
        # endpoint was held to before the token goes there.
        await self._joinable_server(endpoint, named, server_url)
        return WayIn(url=server_url, token=token)

    def _minted(self, endpoint: str, said: bytes) -> tuple[str, str, str]:
        """The token and the server URL out of one answer, or a refusal.

        The refusal names the broken part of the published contract, never
        bytes from the endpoint. Those bytes may have come from an internal
        service and are not safe customer-visible diagnostic text. The key
        the server came under is answered beside the two, so the check that
        follows on the server itself can say which spelling it is refusing.
        """
        try:
            held = json.loads(said)
        except ValueError:
            held = None

        if not isinstance(held, dict):
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered something that is "
                f"not a JSON object",
                ending=ERROR,
            )

        token = next(
            (
                held[alias]
                for alias in TOKEN_ALIASES
                if isinstance(held.get(alias), str) and held[alias].strip()
            ),
            None,
        )
        if token is None:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered no token: Egma "
                f"reads one from {', '.join(TOKEN_ALIASES)}",
                ending=ERROR,
            )

        # From here the token is a credential like any other on this
        # connection: it opens a room in the customer's project, and it is
        # registered before anything else can handle it. Endpoint bodies are
        # never copied into an error, and the token remains a secret for any
        # future diagnostic path added below.
        self._secrets.register([token])

        named = next(
            (alias for alias in SERVER_URL_ALIASES if alias in held), None
        )
        server_url = held.get(named, "") if named is not None else ""
        if not isinstance(server_url, str):
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered a {named} that "
                f"is not a string",
                ending=ERROR,
            )
        server_url = server_url.strip()
        if named is None or not server_url:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered no server_url: "
                f"Egma joins the LiveKit server the answer names, under "
                f"{' or '.join(SERVER_URL_ALIASES)}",
                ending=ERROR,
            )
        return token.strip(), named, server_url

    async def _joinable_server(
        self, endpoint: str, named: str, server_url: str
    ) -> None:
        """Require TLS and public resolved addresses before sending the room token.
        The LiveKit SDK opens its own socket and resolves the host again, so this check
        does not pin its connection against DNS changes. TLS checks the hostname;
        deployment egress policy must block access to internal addresses.
        """
        located = _server_host(server_url)
        if located is None:
            raise _unjoinable(endpoint, named)
        hostname, port = located
        try:
            for address in await self._server_addresses(hostname, port):
                _public_endpoint_address(address)
        except _UnsafeEndpointAddress as unsafe:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered a {named} on a "
                f"non-public network address; Egma joins only a LiveKit "
                f"server on the public internet",
                ending=ERROR,
            ) from unsafe
        except OSError as unresolved:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered a {named} whose "
                f"host could not be resolved",
                ending=ERROR,
            ) from unresolved

    async def _server_addresses(self, hostname: str, port: int) -> list[str]:
        """Every address a server name stands for, or the literal it is.

        A literal address stands for itself and is not looked up. A name
        goes to the resolver a system-boundary test supplied, or to the
        default one, with every address family asked for: the SDK may
        connect over either, so both must pass the policy.
        """
        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            pass
        else:
            return [hostname]

        import aiohttp

        resolver = self._endpoint_resolver or aiohttp.resolver.DefaultResolver()
        try:
            answers = await resolver.resolve(hostname, port, socket.AF_UNSPEC)
        finally:
            if resolver is not self._endpoint_resolver:
                with contextlib.suppress(Exception):
                    await resolver.close()
        addresses = [answer.get("host") for answer in answers]
        if not addresses:
            raise OSError(f"{hostname} resolved to no address")
        return addresses

    async def _delete_room(self) -> None:
        """Delete the room. Never raises — see :func:`delete_room`."""
        await delete_room(
            url=self._settings.url,
            api_key=self._settings.api_key,
            api_secret=self._settings.api_secret,
            room_name=self._room_name,
            quotable=self._quotable,
        )

    async def _asked(self, request: object, what_failed: str) -> None:
        """One request to the customer's LiveKit, or their words about it.

        The two requests this driver makes are the same shape of thing —
        a Twirp call against the room's own project — and they fail the
        same three ways: the server is not there, the key pair is refused,
        or the request is. So they are asked the same way, and what comes
        back is quoted rather than summarised: the platform's own sentence
        is the whole diagnosis, and it is the only one worth printing.
        """
        from livekit import api

        # The client is built inside the guard so that everything that can
        # go wrong here comes out of one door, scrubbed: a URL the library
        # itself will not take is a connection somebody has to fix, and it
        # must read like one rather than like an unnamed crash.
        lkapi = None
        try:
            lkapi = api.LiveKitAPI(
                self._settings.url, self._settings.api_key, self._settings.api_secret
            )
            if isinstance(request, api.CreateRoomRequest):
                await lkapi.room.create_room(request)
            else:
                await lkapi.agent_dispatch.create_dispatch(request)
        except api.ServerError as refused:
            raise platform_refusal(
                what_failed, str(refused.code), self._quotable(refused.message)
            ) from refused
        except Exception as unreachable:
            raise unreachable_refusal(
                what_failed, self._settings.url, self._quotable(repr(unreachable))
            ) from unreachable
        finally:
            if lkapi is not None:
                with contextlib.suppress(Exception):
                    await lkapi.aclose()

    def _nobody_came(self, seconds: float) -> str:
        """Why nobody turned up, worded for whoever has to go and look."""
        if self._settings.given_token:
            # The room and whoever was meant to be in it both belong to the
            # platform that opened it. Egma joined and waited; that is the
            # whole of what this driver can honestly say happened.
            return (
                f"no agent joined the room within {seconds:.0f}s — the "
                f"platform opened it, handed Egma the way in, and never put "
                f"an agent in it"
            )
        if not self._settings.mints_its_own:
            # Whose job it was, said plainly. egma asked for a token and
            # joined with it; it holds no key pair, so it could not have
            # dispatched anybody and is not what went wrong here.
            return (
                f"no agent named {self._settings.agent_name!r} joined "
                f"{self._room_name} within {seconds:.0f}s — the token endpoint "
                f"minted a token and Egma joined the room with it, but nothing "
                f"dispatched the agent. Egma asked for that worker in the "
                f"request's room_config; a connection that names a token "
                f"endpoint hands Egma no key pair, so dispatching is the "
                f"endpoint's own job: copy room_config into the token it "
                f"mints, or dispatch that worker itself, and check that a "
                f"worker registered under that name is running"
            )
        # There is only one arm left here now that the name is demanded:
        # every connection that mints its own token dispatches by name, so
        # the name is always something a person can go and look for.
        return (
            f"no agent named {self._settings.agent_name!r} joined the room "
            f"within {seconds:.0f}s — check that a worker registered under "
            f"that name is running"
        )

    def _quotable(self, told: str) -> str:
        """Somebody else's words, minus this connection's secret, short
        enough to read. A server that echoed the api secret back must not
        get it repeated into a reason or into the traceback under one."""
        return self._secrets.redact(told)[:QUOTED_REFUSAL_CHARS]


# -- The room carrying speech ------------------------------------------------


class LiveKitRoomBackend(RoomLifecycle):
    """The room with a Pipecat transport in it: one voice exchange.

    The four verbs of the module docstring, minus the two the lifecycle
    above already answers. What is left here is the join — which builds
    the stock LiveKit transport the one running pipeline owns — and the
    wait that follows it.
    """

    MODALITY = "voice"

    async def create_transport(self) -> VoiceMedia:
        """Get a way into the room and build its Pipecat transport."""
        way_in = await self._way_in()
        self._server_url = way_in.url
        self._room = self._joined_room(way_in)
        self._room.watch_startup(self._startup)
        self._room.answer_when_joined(self._answer_for_mocked_tools)
        return self._room.create_transport()

    async def wait_answered(self, seconds: float) -> str:
        """Keep the bounded arrival and audio contract for non-Egma room users."""
        deadline = asyncio.get_running_loop().time() + seconds
        if not await self._wait_arrivals(seconds):
            raise MediaBackendError(
                self._nobody_came(seconds), ending=AGENT_NEVER_JOINED
            )
        left = deadline - asyncio.get_running_loop().time()
        if left <= 0 or not await first_of(self._room.carrying_audio, within=left):
            raise MediaBackendError(
                f"an agent joined the room but published no audio within "
                f"{seconds:.0f}s; check that the worker publishes a track "
                "rather than only subscribing",
                ending=AGENT_NEVER_JOINED,
            )
        return self._room_name

    def _joined_room(self, way_in: WayIn) -> JoinedRoom:
        """The way into the room, with a token that opens it and nothing
        else: one room, one identity, for the length of one simulation."""
        return JoinedRoom(
            url=way_in.url,
            token=way_in.token,
            room_name=self._room_name,
            quotable=self._quotable,
            confirm_remote_end=self._confirm_remote_end,
        )


# Chat room transport: text topics only. The egma-sim-chat- prefix tells
# an integrated agent worker to disable speech.


@dataclass(frozen=True)
class Utterance:
    """One thing the agent said, as one closed transcription stream."""

    text: str
    """The words, whole, because a stream is read to its close."""

    spoken: bool
    """Whether the stream carried :data:`SPOKEN_TRACK_ATTRIBUTE`.

    True means these words were synchronised to audio the agent
    published — the wire saying the agent is talking rather than typing,
    which in a chat simulation means the chat setup is missing.
    """

    turn: int
    """Which persona turn was outstanding when this stream *opened*.

    Stamped at the stream's header rather than at its close, which is what
    makes it an answer to the question that had been asked — a stream can
    take longer to finish than egma waited for it, and finishing late does
    not make it a reply to whatever was asked next. Reading it as one
    would put the agent's words against a question it never answered.
    """

    opened: int
    """Stream-open order used to join utterances. Streams can finish out of order."""


@dataclass(frozen=True)
class AgentTurn:
    """Everything the agent produced between two persona turns."""

    text: str | None
    """What it said, or ``None`` for a turn that carried no words — which
    is the honest record of a turn that only called a tool."""

    ended: bool
    """Whether the agent left the room, which is the agent ending the
    exchange. There is no other signal and no better one."""

    speaking: bool
    """Whether the wire says this agent is speaking rather than typing:
    an audio track in the room, or text carrying the transcribed-track
    mark. Either one means the agent never took the chat setup, and the
    plug above ends the simulation rather than grading it."""

    answer_began_at: float | None = None
    """Answer start on the event loop clock, or None without an answer.
    The conversation loop supplies the starting line for turn_response_latency.
    """


class TextRoom:
    """Chat room with participant events, text streams, and mock-tool RPC; no audio
    pipeline.
    Track open readers as well as completed utterances so take_turn() can drain
    streams that started before the turn ended.
    """

    def __init__(
        self,
        *,
        url: str,
        token: str,
        room_name: str,
        quotable: Callable[[str], str] = lambda told: told,
    ) -> None:
        self._url = url
        self._token = token
        self._room_name = room_name
        self._quotable = quotable
        self._room: Any = None
        self._leaving = False
        self._reading: dict[asyncio.Task[None], int] = {}
        """Every stream being read, against the turn it opened in.

        A set of tasks was enough while nothing asked *whose* they were.
        Half of the turn-end rule is that a turn does not end while a
        stream it opened is still open, and answering that needs the
        stamp beside the task rather than only inside the utterance the
        task has not produced yet.
        """
        self._opened = 0
        """How many streams this room has seen open, ever. The order key
        an utterance carries, and the reason a turn can be joined in the
        order the agent said it rather than the order it finished."""
        self._answer_began: dict[int, float] = {}
        """First stream-open timestamp per turn, used as the answer-latency finish line.
        Later streams continue the same answer and must not replace its start time.
        """
        self.utterances: asyncio.Queue[Utterance] = asyncio.Queue()
        self._turn = 0
        """Which persona turn is outstanding. Nought is the greeting's, which
        is the only turn the agent takes before it has been asked anything."""
        self.arrivals = asyncio.Event()
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self.audio_published = asyncio.Event()
        self.agent_finished = asyncio.Event()
        """Finished-state latch. Clear at turn start and for streams opened after the
        signal.
        Streams already open at the signal do not clear it: text and state can arrive
        in either order on separate channels.
        """
        self._finished_after = 0
        """How many streams this room had seen open when the latch above
        was last set. The whole of what tells the two orderings apart: an
        utterance stamped past this number opened after the agent said it
        had finished, and one stamped at or below it is the trailer of
        something the agent had already finished saying."""
        self.agent_state: str | None = None
        """The last state the agent published about itself, or ``None``
        where it has never published one. Kept for what it says in a log
        about a turn that went wrong; nothing decides on it directly,
        because a state egma has not seen is not a state that did not
        happen."""
        self._startup: LiveKitStartup | None = None
        self._event_handlers: list[tuple[str, Callable[..., None]]] = []

    @property
    def joined(self) -> bool:
        return self._room is not None

    def watch_startup(self, startup: LiveKitStartup) -> None:
        """Attach the startup latch before room event handlers are registered."""
        self._startup = startup

    async def join(self) -> None:
        """Enter the room as a participant that publishes nothing."""
        from livekit import rtc

        room = rtc.Room()
        self._watch(room)
        try:
            await room.connect(
                self._url,
                self._token,
                # Subscribed to nothing, because there is nothing here to
                # hear: a chat simulation reads words, and a subscription
                # would decode audio no part of this grades.
                rtc.RoomOptions(auto_subscribe=False),
            )
        except Exception as unreachable:
            raise MediaBackendError(
                f"the livekit server at {self._url} did not let the simulator "
                f"into a room: {self._quotable(repr(unreachable))}",
                ending=ERROR,
            ) from unreachable
        self._room = room
        # A worker already in the room when egma arrives fires no
        # connection event, so the roster is read once rather than only
        # waited on — otherwise a fast dispatch into a slow join would
        # look exactly like a worker that never came.
        for participant in room.remote_participants.values():
            self.arrivals.set()
            startup = self._startup
            if startup is not None:
                startup.participant_seen(
                    getattr(participant, "identity", ""),
                    getattr(participant, "attributes", None),
                )
            for publication in participant.track_publications.values():
                if getattr(publication, "kind", None) == rtc.TrackKind.KIND_AUDIO:
                    self.audio_published.set()

    def _watch(self, room: Any) -> None:
        """Register event handlers before connect so an already-present agent's first
        output
        cannot race registration. Test rooms use these same callback signatures.
        """
        from livekit import rtc

        room.register_text_stream_handler(TRANSCRIPTION_TOPIC, self._agent_said)

        @room.on("participant_connected")
        def _arrived(participant: Any) -> None:
            self.arrivals.set()
            startup = self._startup
            if startup is not None:
                startup.participant_seen(
                    getattr(participant, "identity", ""),
                    getattr(participant, "attributes", None),
                )

        @room.on("participant_disconnected")
        def _left(participant: Any) -> None:
            identity = getattr(participant, "identity", "")
            startup = self._startup
            if startup is not None:
                startup.participant_left(identity)
            if not self._leaving and (
                startup is None or startup.is_relevant(identity)
            ):
                self.ended.set()

        @room.on("participant_attributes_changed")
        def _stated(changed: dict[str, str], participant: Any) -> None:
            # The agent's own word for where it is in its turn, on the one
            # channel that carries an end-of-turn marker at all. The
            # changed attributes come *first* and the participant second,
            # which is this event alone among the participant events —
            # every other one puts the participant first — and is why
            # nothing below this line may be the only thing a test drives.
            self._note_agent_state(changed, getattr(participant, "identity", ""))

        @room.on("track_published")
        def _published(publication: Any, _participant: Any) -> None:
            # Egma publishes nothing here, so a track in this room is the
            # agent's — and an agent publishing audio in a chat simulation
            # is an agent that never read the modality off its room's name.
            if getattr(publication, "kind", None) == rtc.TrackKind.KIND_AUDIO:
                self.audio_published.set()

        @room.on("disconnected")
        def _dropped(reason: object = None) -> None:
            log_event(
                logger,
                logging.INFO,
                "egma.media.disconnected",
                "livekit chat room disconnected",
                attributes={
                    "livekit.disconnect_reason": disconnect_reason_name(reason)
                },
            )
            if self._leaving or self.failed.is_set() or self.ended.is_set():
                return
            if (
                self._room is not None
                and self.arrivals.is_set()
                and room_was_deleted(reason)
            ):
                # DeleteRoom is LiveKit's supported way to end a session.
                # next_utterance still settles text already on its way in.
                self.ended.set()
            else:
                self.failed.set()

        self._event_handlers = [
            ("participant_connected", _arrived),
            ("participant_disconnected", _left),
            ("participant_attributes_changed", _stated),
            ("track_published", _published),
            ("disconnected", _dropped),
        ]

    async def wait_connected(self) -> None:
        """Joining is what connected it; this is where that is checked."""
        if self._room is None:
            raise MediaBackendError(
                f"the livekit server at {self._url} was asked for an agent "
                "before the simulator had joined a room",
                ending=ERROR,
            )

    def note_anybody_already_here(self) -> None:
        """Count whoever was in the room before egma got into it.

        The join above already read the roster once, so this is ordinarily
        nothing to do — it exists because the lifecycle asks every room
        the same question at dial, and the answer must never depend on
        which driver is underneath. One local read, never a raise.
        """
        room = self._room
        if self.arrivals.is_set() or room is None:
            return
        try:
            present = room.remote_participants
        except Exception:
            return
        if present:
            self.arrivals.set()

    def register_rpc(
        self,
        method: str,
        handler: RpcMethod,
        *,
        on_attempt: RpcNotice | None = None,
        on_accepted: RpcNotice | None = None,
        on_refused: RpcRefusalNotice | None = None,
    ) -> None:
        """Offer one mock-tool method on egma's own participant.

        The same seam the voice room offers, through the same wrapper: the
        exchange knows nothing about rooms, and nothing about whether the
        conversation around it is spoken or typed.
        """
        if self._room is None:
            raise MediaBackendError(
                f"{method} was offered before the room was joined", ending=ERROR
            )
        self._room.local_participant.register_rpc_method(
            method,
            answering(
                handler,
                on_attempt=on_attempt,
                on_accepted=on_accepted,
                on_refused=on_refused,
            ),
        )

    async def send(self, text: str) -> None:
        """Type one persona turn into the room."""
        if self._room is None:
            raise MediaBackendError(
                "a persona turn was typed before the room was joined", ending=ERROR
            )
        try:
            await self._room.local_participant.send_text(text, topic=CHAT_TOPIC)
        except Exception as unsent:
            raise MediaBackendError(
                f"the persona's turn could not be sent into {self._room_name}: "
                f"{self._quotable(repr(unsent))}",
                ending=ERROR,
            ) from unsent

    def begin_turn(self) -> int:
        """Say that a new persona turn is going out, and answer which.

        Every stream that opens from here on belongs to this turn, and
        every stream already open belongs to one before it — which is the
        whole of the rule that keeps an answer under the question it
        answers.
        """
        self._turn += 1
        # Whatever the agent last said about itself, it said about the turn
        # before this one. A finished state that arrived then must not end
        # a turn that has not been answered yet.
        self.agent_finished.clear()
        # The turns that have ended cannot be asked about again, and a
        # simulation of a thousand turns should not carry a thousand
        # instants to answer a question only ever asked about the newest.
        self._answer_began.clear()
        return self._turn

    async def next_utterance(
        self, *, within: float, finished_ends_it: bool = False
    ) -> Utterance | None:
        """Wait for an utterance, departure, disconnect, audio output, or finished
        state.
        Enable finished_ends_it only after first output; startup listening must not
        end the greeting. None does not complete a turn: its open streams still need
        draining.
        """
        if not self.utterances.empty():
            return self.utterances.get_nowait()
        taking = asyncio.ensure_future(self.utterances.get())
        watched = [self.ended, self.failed, self.audio_published]
        if finished_ends_it:
            watched.append(self.agent_finished)
        stopping = [asyncio.ensure_future(event.wait()) for event in watched]
        try:
            done, _pending = await asyncio.wait(
                [taking, *stopping],
                return_when=asyncio.FIRST_COMPLETED,
                timeout=within,
            )
        finally:
            for unfinished in (taking, *stopping):
                if not unfinished.done():
                    unfinished.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await unfinished
        if taking in done:
            return taking.result()
        if self.ended.is_set():
            await self._settled()
            if not self.utterances.empty():
                return self.utterances.get_nowait()
        return None

    async def leave(self) -> None:
        """Leave the room, and stop reading whatever was still arriving."""
        room, self._room = self._room, None
        self._leaving = True
        self.ended.set()
        readers = list(self._reading)
        for reader in readers:
            if not reader.done():
                reader.cancel()
        if readers:
            await asyncio.gather(*readers, return_exceptions=True)
        self._reading.clear()
        if room is None:
            return
        for event, handler in self._event_handlers:
            room.off(event, handler)
        self._event_handlers.clear()
        room.unregister_text_stream_handler(TRANSCRIPTION_TOPIC)
        try:
            await room.disconnect()
        except Exception as unfinished:
            logger.warning(
                "the exchange's room was not left cleanly: %s",
                self._quotable(repr(unfinished)),
            )

    # -- Reading what the agent said ------------------------------------------

    def _agent_said(self, reader: Any, identity: str) -> None:
        """One transcription stream opened; read it to its close.

        Called the moment a stream's header arrives, before a word of it
        exists, so the whole of the work is reading it to the end and
        putting it down. Egma's own turns come back on this topic too
        wherever the agent transcribes what it was told, so a stream sent
        by egma's own participant is dropped rather than read as the agent
        answering itself.
        """
        if identity == PERSONA_IDENTITY:
            return
        self._opened += 1
        turn = self._turn
        # Before the reading, because this is the header's own moment and
        # the finish line is the header rather than anything it carries.
        self._answer_began.setdefault(turn, asyncio.get_running_loop().time())
        reading = asyncio.create_task(
            self._read(reader, turn, self._opened), name="livekit-agent-utterance"
        )
        # Held against its turn, not merely held: what the turn-end rule
        # asks of this set is which streams *this* turn is still owed.
        self._reading[reading] = turn
        reading.add_done_callback(lambda done: self._reading.pop(done, None))

    def _note_agent_state(self, changed: dict[str, str], identity: str) -> None:
        """Latch remote finished states, ignoring Egma's own participant.
        Do not require a prior thinking or speaking event: rapid transitions can
        coalesce.
        """
        if identity == PERSONA_IDENTITY:
            return
        state = changed.get(AGENT_STATE_ATTRIBUTE)
        if state is None:
            return
        startup = self._startup
        if startup is not None:
            startup.participant_state(identity, state)
        self.agent_state = state
        if state in AGENT_FINISHED_STATES:
            # Stamped with the room's stream count, so a landing utterance
            # can be told from this state by which came first. Without the
            # stamp every landing utterance cleared the latch, and a
            # ``listening`` that beat its own turn's last trailer — an
            # ordinary race between two channels — was thrown away and the
            # turn paid the whole quiet period it had just been told it
            # need not pay.
            self._finished_after = self._opened
            self.agent_finished.set()

    def streams_open_in(self, turn: int) -> int:
        """How many streams this turn opened have not closed yet.

        The question a queue cannot answer, and the one half the turn-end
        rule turns on: an utterance that has begun arriving is owed to the
        turn it began in, however long it takes to finish.
        """
        return sum(
            1
            for reading, stamped in self._reading.items()
            if stamped == turn and not reading.done()
        )

    def answer_began_in(self, turn: int) -> float | None:
        """When this turn's answer started, or ``None`` if it never did.

        ``None`` is a real answer and not a gap: a turn that only called a
        tool, or one the agent never answered at all, has no moment where
        it began replying — so it contributes no latency sample rather
        than a made-up one. The voice lane answers the same way, for the
        same reason, out of the audio.
        """
        return self._answer_began.get(turn)

    async def settle_turn(self, turn: int, *, within: float) -> None:
        """Wait within the drain budget without cancelling unfinished stream readers.
        Use asyncio.wait so late words and diagnostics remain available.
        streams_open_in() reports readers still open after the wait.
        """
        reading = [
            reading
            for reading, stamped in self._reading.items()
            if stamped == turn and not reading.done()
        ]
        if not reading:
            return
        await asyncio.wait(reading, timeout=max(within, 0.0))

    async def _read(self, reader: Any, turn: int, opened: int) -> None:
        """One utterance, whole, or a line about why it was not.

        ``turn`` is the one that was outstanding when this stream opened
        and ``opened`` is where it opened in the room's order of streams,
        both taken by the caller at the header. They travel with the words
        because by the time the words are all here the answer may be to a
        question two turns old, and because the order streams finish in is
        not the order the agent said them in.
        """
        attributes = getattr(reader.info, "attributes", None) or {}
        spoken = SPOKEN_TRACK_ATTRIBUTE in attributes
        try:
            said = await reader.read_all()
        except asyncio.CancelledError:
            raise
        except Exception as unread:
            # One of the two ways an utterance leaves the record, and the
            # log has to say which: this is the whole stream lost, so the
            # length is not known and cannot be. The other way names a
            # length every time, which is how the two are told apart on a
            # record from a production run.
            logger.warning(
                "an utterance left the record on the unread-stream path: the "
                "stream opened in turn %d in room %s never reached its close, "
                "so none of its words are on the record and how many there "
                "were is not known: %s",
                turn,
                self._room_name,
                self._quotable(repr(unread)),
            )
            return
        said = said.strip()
        # An empty stream is nothing the agent said, so nothing goes on
        # the record for it — unless it carried the speaking mark, which
        # is a fact about the agent rather than about the words.
        if said or spoken:
            self.utterances.put_nowait(
                Utterance(text=said, spoken=spoken, turn=turn, opened=opened)
            )
            # An utterance landing now outranks a finished state that
            # arrived before its stream opened: that stream is the agent
            # still writing when it announced it had stopped. A finished
            # state that arrived while this stream was already open
            # outranks nothing, because it is about these very words.
            if opened > self._finished_after:
                self.agent_finished.clear()

    async def _settled(self) -> None:
        """Let a stream the agent closed on its way out finish arriving.

        Every open stream, whatever turn it opened in, because a departure
        is not a turn boundary: the goodbye an agent leaves on is the last
        thing it will ever say and there is no next turn to owe it to.
        """
        reading = [reader for reader in self._reading if not reader.done()]
        if not reading:
            return
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(STREAM_CLOSE_SECONDS):
                await asyncio.gather(*reading, return_exceptions=True)


class LiveKitChatRoomBackend(RoomLifecycle):
    """The room with nobody speaking in it: one typed exchange.

    Everything about the room is the lifecycle above; what is here is the
    join that publishes nothing, the wait for the worker, and the one
    thing chat has that voice does not — deciding where a turn ends.
    """

    MODALITY = "chat"

    @property
    def has_ended(self) -> bool:
        """Whether this room already observed its normal remote ending."""
        return self._room is not None and self._room.ended.is_set()

    def _fresh_room_name(self) -> str:
        """The marked form: ``egma-sim-chat-`` says which kind of
        simulation this room conducts, to a worker deciding its room
        options before it has connected to anything."""
        return fresh_chat_room_name()

    def _room_name_for(self, simulation_id: str) -> str:
        """The marked form again, for the room an endpoint is asked for.

        The worker reads ``egma-sim-chat-`` off the name however the token
        was minted, and the endpoint's ``egma-sim-`` allowlist still
        matches: the bare prefix is inside the marked one.
        """
        return chat_room_name_for(simulation_id)

    async def open_room(self) -> None:
        """Get a way into the room and join it, publishing nothing."""
        way_in = await self._way_in()
        self._server_url = way_in.url
        self._room = self._joined_room(way_in)
        self._room.watch_startup(self._startup)
        await self._room.join()
        # The offer goes on at the join itself, exactly as the voice room
        # makes it on its connect: egma is in the room from this line, and
        # a worker can be typing its hello the moment egma is visible.
        # The second ask in `dial` then returns having nothing to do.
        self._answer_for_mocked_tools()

    def _joined_room(self, way_in: WayIn) -> TextRoom:
        """The way into the room, with a token that opens it and nothing
        else: one room, one identity, for the length of one simulation."""
        return TextRoom(
            url=way_in.url,
            token=way_in.token,
            room_name=self._room_name,
            quotable=self._quotable,
        )

    async def wait_greeting(
        self, seconds: float, *, quiet_seconds: float, drain_seconds: float
    ) -> AgentTurn:
        """Collect an optional greeting using its own first-output budget.
        Ignore finished state until words arrive; otherwise startup listening could
        end the greeting early. No greeting lets the persona speak first.
        """
        # Nought: the only turn the agent takes before it has been asked
        # anything is the one it opens with.
        return await self._assembled(
            first_within=seconds, quiet=quiet_seconds, drain=drain_seconds, turn=0
        )

    async def deliver(
        self,
        text: str,
        *,
        reply_seconds: float,
        quiet_seconds: float,
        drain_seconds: float,
    ) -> AgentTurn:
        """Send persona text, then collect the answer with separate start and quiet
        budgets.
        Begin the new turn immediately after send returns, without another await.
        Only streams opened in that turn belong to its answer; earlier streams remain
        assigned to their original turn even if they finish later.
        """
        room = self._room
        if room is None:
            raise MediaBackendError("a persona turn was delivered before a room")
        await room.send(text)
        turn = room.begin_turn()
        return await self._assembled(
            first_within=reply_seconds,
            quiet=quiet_seconds,
            drain=drain_seconds,
            turn=turn,
            silence_ends_it=True,
        )

    async def send(self, text: str) -> None:
        """Send one final turn without opening another answer window."""
        room = self._room
        if room is None:
            raise MediaBackendError("a persona turn was delivered before a room")
        await room.send(text)

    async def wait_ended(self) -> None:
        """Wait for the room's observed normal ending."""
        room = self._room
        if room is None:
            raise MediaBackendError("an ending was awaited before a room")
        await room.ended.wait()

    async def _assembled(
        self,
        *,
        first_within: float,
        quiet: float,
        drain: float,
        turn: int,
        silence_ends_it: bool = False,
    ) -> AgentTurn:
        """Collect one agent turn, preserving utterances in stream-open order.

        After the first words, a finished agent state or the quiet period ends input.
        Do not use the state signal before first output: startup can publish listening
        before the greeting. Assign streams to the turn when they open, then drain
        its open streams before returning. Reset the bounded drain wait as utterances
        arrive; log when the bound expires.

        Audio output or disconnection prevents entry into drain. Once draining starts,
        only this turn's readers are watched until the wait ends.
        With silence_ends_it, an unanswered persona turn ends the exchange so a late
        stream cannot be assigned to the next question. The optional greeting is exempt.
        """
        room = self._room
        if room is None:
            raise MediaBackendError("an answer was read before a room")
        clock = asyncio.get_running_loop()
        said: list[Utterance] = []
        heard = False
        speaking = room.audio_published.is_set()
        budget = first_within
        left_to_drain = drain
        while not speaking:
            # The state signal only answers the second question a turn
            # asks — whether there is more to come — so it is off until
            # something has come. Before that the caller's own budget owns
            # the wait, because a session announces itself listening
            # before it has said a word.
            utterance = await room.next_utterance(
                within=budget, finished_ends_it=heard
            )
            if utterance is None:
                # An audio track appearing is not this turn ending, it is
                # the wire saying the agent is speaking — and there is
                # nothing about a still-open stream worth waiting for
                # then. The answer is the refusal above this driver, and
                # it is owed at the agent's first output rather than at
                # the end of a bound.
                if room.audio_published.is_set():
                    speaking = True
                    break
                # The server dropped egma, which is a fault rather than a
                # turn. The raise below this loop is the whole answer, and
                # waiting the bound out would spend it on a room that is
                # gone — and then file a line saying the words will be
                # refused by the turn after, when there is no turn after.
                if room.failed.is_set():
                    break
                # Nothing more will arrive on its own. What can still
                # arrive is a stream this turn already owns.
                if not room.streams_open_in(turn):
                    break
                began = clock.time()
                await room.settle_turn(turn, within=left_to_drain)
                left_to_drain -= clock.time() - began
                still_open = room.streams_open_in(turn)
                # Only a spent bound ends the turn here. A stream still
                # open with time left on the bound is one that opened
                # *during* the wait — the agent starting another utterance
                # of this same turn — and calling that a stalled stream
                # would drop it and file a line saying the opposite of
                # what happened.
                if still_open and left_to_drain <= 0:
                    logger.warning(
                        "an utterance may leave the record on the open-stream "
                        "path: %d stream(s) opened in turn %d in room %s had "
                        "not closed after the whole %.1fs bound, so the turn "
                        "ends without them and whatever they carry will be "
                        "refused by the turn after. The agent's last "
                        "published state was %s",
                        still_open,
                        turn,
                        self._room_name,
                        drain - left_to_drain,
                        room.agent_state or "nothing at all",
                    )
                    break
                # Whatever closed is on the queue now, so take it before
                # waiting on anything: the turn is not over, it was only
                # slower than the wait for it.
                budget = 0.0
                continue
            if utterance.turn < turn:
                # An answer to a question two turns ago, finishing now. The
                # budget is what makes this rare; the stamp is what keeps it
                # from being read as an answer to the question just asked.
                logger.warning(
                    "an utterance left the record on the stale-turn path: a "
                    "stream opened in turn %d closed during turn %d in room "
                    "%s, after the turn it belonged to had already ended, so "
                    "its %d characters are on no turn at all",
                    utterance.turn,
                    turn,
                    self._room_name,
                    len(utterance.text),
                )
                continue
            heard = True
            if utterance.text:
                said.append(utterance)
            speaking = utterance.spoken or room.audio_published.is_set()
            budget = quiet
            # And the bound starts again, because it is a bound on one
            # stream and not on the turn. Words landing say the agent is
            # writing rather than stalled, and a turn of several honest
            # slow utterances would otherwise spend the whole of it on the
            # ones that already arrived and drop the last for a delay that
            # was the others'.
            left_to_drain = drain
        if room.failed.is_set():
            raise MediaBackendError(
                f"the livekit server at {self._server_url} closed "
                f"{self._room_name} while the exchange was under way",
                ending=ERROR,
            )
        if silence_ends_it and not heard and not speaking and not room.ended.is_set():
            raise MediaBackendError(
                f"the agent said nothing at all for {first_within:.0f} seconds "
                f"after the persona's turn in {self._room_name}. Egma stops "
                "here rather than ask again: an answer to this turn could "
                "still open its stream after the next question went out, and "
                "nothing on the wire would tell it from an answer to that "
                "one — so going on risks a transcript where the agent "
                "appears to answer a question it was never asked",
                ending=ERROR,
            )
        return AgentTurn(
            # In the order the streams opened, which is the order the agent
            # said them. A stream that opens first and closes last arrives
            # last, and joining on arrival put the agent's opening words
            # behind the sentence that followed them.
            text="\n".join(
                utterance.text
                for utterance in sorted(said, key=attrgetter("opened"))
            )
            or None,
            ended=room.ended.is_set(),
            speaking=speaking,
            answer_began_at=room.answer_began_in(turn),
        )
