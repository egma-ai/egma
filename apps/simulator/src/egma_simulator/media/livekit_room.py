"""The livekit-room driver: the agent's own room, joined and dispatched into.

The agent under test lives in a LiveKit room. So egma gets into one — in
the *customer's* LiveKit project, not the deployment's — as an ordinary
participant, gets the agent's worker into it, holds the exchange, and
tidies up when it is over. That is the whole of this file, in the four
verbs every media driver has (see :mod:`egma_simulator.media`):

1. ``create_transport`` — come by a token and a room, then build
   Pipecat's stock transport. The simulator needs no inbound network
   surface: it opens the websocket and negotiates the media.
2. ``dial`` — get the agent in, by name, always explicitly. LiveKit
   would hand a new room to a worker registered without a name on its
   own, and egma deliberately does not lean on that: **a room filled
   automatically is a room where the record cannot say which agent it
   graded** — whichever workers were listening took it — and where the
   test's job dispatch metadata has no dispatch of egma's to ride.
   The simulation's own signals need no dispatch to travel: the room's
   name carries them (``egma-sim-`` says simulation, ``egma-sim-chat-``
   says which kind), and egma is found among the room's participants by
   the identity it joined as. So the connection names the agent, and one
   that names none is refused at the settings read, before anything is
   reached.
3. ``wait_answered`` — the agent's participant arrives and its audio
   flows, within a bounded wait. Both halves matter: a participant that
   joins and publishes nothing is a worker that crashed on its first
   frame, and an exchange conducted against it would grade an agent that
   never spoke.
4. ``teardown`` — leave, and delete the room where egma has the power to.
   Deleting is what ends everything the room held, including a dispatched
   worker.

## The three ways in

Step 1 is where the connection's shapes differ, and they differ over one
question: who mints the token that opens the room.

- **egma mints it.** The connection carries the project's ``apiKey`` and
  ``apiSecret``. egma creates a fresh ``egma-sim-``-prefixed room, signs a
  token that opens that room and nothing else, dispatches the worker, and
  deletes the room at the end.
- **The customer mints it.** The connection names a ``tokenEndpoint``
  instead, and the secret that signs tokens for their whole project never
  leaves their side. egma invents the room and participant names, POSTs
  them in LiveKit's standard token request — with a ``room_config`` naming
  the worker to dispatch and carrying the test's job dispatch metadata —
  and joins the server the answer names with the token that comes back.
  It holds no key pair, so the dispatch is the endpoint's to perform, by
  copying that block into the token it mints, and the reason a room
  nobody joined gives says so; and it cannot delete, so it leaves the
  room for the customer's own empty timeout to close.
- **A platform minted it, opening the room itself.** The caller was handed
  a ``given_token`` and the platform's own server URL — what a call created
  through somebody's API comes back as — so egma asks nobody for anything:
  it joins, and the token is spent on that one join. Getting the agent in
  was the platform's own doing when it opened the room, and deleting is
  beyond a token that only opens one; egma leaves and the platform closes
  what it made.

Above :class:`WayIn` the three are one code path. Everything after "a
token and a room name exist" — joining, waiting, conducting, leaving — is
the same code whichever it was, which is what keeps a second shape from
being a second driver.

Two deliberate differences from the driver that places a phone call:

- **Configuration arrives from the spec's connection block**, never from
  this deployment's environment. The room is the customer's: their
  LiveKit project, their key pair, their agent. A trunk belongs to a
  deployment and a room does not, so nothing in this file reads an
  environment variable.
- **"Dial" means dispatch, not SIP.** Nothing is called; a worker is
  asked for.

## Two currencies, one room

A room can carry speech or it can carry typing, and everything *about
the room* is the same either way: making it, signing a token for it,
asking a customer's endpoint for one, dispatching a worker into it,
offering the mock-tool seam in it, deleting it, and every sentence and
every scrubbing above. Only the join differs — a voice join hands
Pipecat a full-duplex transport, and a chat join is a bare
``rtc.Room`` with text-stream handlers and no media at all.

So that shared half is :class:`RoomLifecycle`, and the two drivers are
subclasses of it that differ in what a join produces and in what they
then wait for. :class:`LiveKitRoomBackend` is the voice one, with the
four verbs above. :class:`LiveKitChatRoomBackend` is the chat one, and
it waits for a participant and then for words rather than for audio.
Neither is written beside the other: a second copy of the room
lifecycle would drift from the first, and the first anybody would know
is a customer's simulation.

## The one metadata channel egma writes on

A room carries two, and egma writes on exactly one:

- **Dispatch metadata** is the test's own ``job_dispatch_metadata``,
  written as one compact JSON string. It is the channel LiveKit's own
  documentation teaches agents to read for per-session context, so an
  agent doing ``json.loads(ctx.job.metadata)["their_key"]`` finds the
  keys this scenario meant it to find. A test that wrote none dispatches
  the empty string, which is what that agent meets in its own production
  rooms. Where a customer's endpoint mints the token, the same string goes
  to that endpoint inside ``room_config``, as the metadata of the dispatch
  egma asks it for, and the endpoint copies it into the token.
- **Room metadata** is left empty, always. The value belongs to one
  simulation and the dispatch is what carries one simulation's worker
  into the room, so writing it in a second place would be a second thing
  to keep true.

Neither carries **anything else of the test's content** — no scenario
text, no persona, no expected behavior, and no mock answer — because an
agent that reads its script stops being under test. What a test does put
here it wrote key by key, as the world its worker starts in: a tenant, a
caller id, the account the scenario is about.

**Where egma's own signal lives instead.** Not in either of these. An
agent learns it is in a simulation from the room's name, which begins
``egma-sim-`` on every way into a room, and it addresses egma by the
persona's participant identity — see :mod:`egma_simulator.media.room`,
where both are declared as the published contracts they are. Dispatch
metadata cannot carry that signal: where a platform opened the room egma
writes no metadata at all, and on the endpoint shape the test's string
rides only as far as the request — the customer's endpoint decides what
the token it mints carries — so an agent reading that channel for egma's
context could find nothing and conclude it was in production while a
simulation ran around it.

## Answering for the agent's tools

A room driver is also where egma stands in the agent's tool path, for the
simulations that mock anything. The two methods are registered on egma's
participant the moment the room is joined, and what answers them knows
nothing about rooms — see :mod:`egma_simulator.mock_tools`, which owns
the exchange and the record it leaves. Room membership is the whole of the
authorisation, which is why a room with no egma participant leaves the
agent's tools untouched by construction.

## Which failed ending a refusal deserves

- :data:`AGENT_NEVER_JOINED` — the room opened and nobody came. A worker
  that is down, or one registered under a different name than the
  connection asks for. Never the agent failing: nothing was tested.
- :data:`ERROR` — the server could not be reached, the token was refused,
  the room could not be created or dispatched into. Somebody has
  something to fix, and the platform's own words say what, scrubbed of
  the credentials it was given.

## Credentials

The key pair arrives on the connection and is used to reach the room and
for nothing else: never logged, never in an exception message, never in a
returned value. Whatever the platform says back is quoted through this
driver's own :class:`egma_simulator.redaction.SecretRegistry` first, so a
server that echoes a secret cannot get it repeated onto the record.

(``from livekit import api`` inside this file reaches the installed
LiveKit package, not the module beside it: Python resolves imports
absolutely. Every such import sits inside a function, so a simulator that
joins no room never loads the library — see the quarantine suite.)
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import socket
from collections.abc import Callable
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
from ..redaction import SecretRegistry
from . import MediaBackendError, VoiceMedia
from .room import (
    PERSONA_IDENTITY,
    QUOTED_REFUSAL_CHARS,
    JoinedRoom,
    RpcMethod,
    answering,
    chat_room_name_for,
    delete_room,
    first_of,
    fresh_chat_room_name,
    fresh_room_name,
    persona_name_for,
    room_name_for,
    room_token,
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
"""What the token-endpoint access variant's config holds — and what it
does not.

The worker's name is here because egma can ask for the dispatch without a
key pair: LiveKit's standard token request carries a ``room_config`` block
naming the agents to dispatch, the endpoint copies it into the token it
mints, and LiveKit dispatches them when the room is created. The test's
``job_dispatch_metadata`` rides that same block, as the dispatch's
metadata, and arrives with the simulation rather than with the connection
— on this variant as on the other. What is *not* here is a server url. The
endpoint's answer names the server — ``server_url`` beside
``participant_token``, exactly as LiveKit's own token endpoints answer —
so a url held on the connection would be a second answer to a question the
endpoint settles, and a key the driver would read and quietly prefer one
way or the other is worse than one it refuses by name.
"""

ENDPOINT_CREDENTIAL_KEYS = frozenset({"headers"})
PLATFORM_NAMED_ROOM = "the room the platform opened"
"""What egma calls a room it did not name.

The given-token shape joins a room somebody else made, and its real name
belongs to them: egma is handed a way in and never told what the room is
called. So this is a description and deliberately not an identifier —
Pipecat prints the room name into every connect and disconnect line, and a
name invented here would read like a room that could be looked up, in
telemetry where no such room exists. What joins the two sides on this
shape is the platform's own id for the exchange, which the plug carries as
the provider reference.
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
"""The text-stream topic the agent's own words come back on.

One stream per utterance, opened at its first chunk and closed when that
utterance is done. The close is an end-of-*utterance* marker and nothing
more: an agent that says a filler, calls a tool and then answers sends
three streams for one turn. What says the *turn* is over arrives on
another channel entirely — :data:`AGENT_STATE_ATTRIBUTE`.

This docstring used to say the close was the only end-of-turn marker this
wire has. It was not, and that sentence is why the driver below waited out
a fixed quiet period on every turn instead of reading the marker the
platform already publishes. Corrected here so nobody derives the old rule
from the old sentence a second time.
"""

AGENT_STATE_ATTRIBUTE = "lk.agent.state"
"""The participant attribute an agent publishes its own turn state on.

LiveKit's own agent session sets it on every change of state, out of
``RoomIO`` — which registers that handler whether or not the session has
any audio in it, so a text-only agent publishes it exactly as a speaking
one does. Against an agent built the **STT-LLM-TTS** way a chat
simulation therefore watches it go ``listening`` → ``thinking`` →
``speaking`` → ``listening``, with ``speaking`` flipped by the first
forwarded *text* where there is no audio output to flip it, and the
return to ``listening`` is the end-of-turn marker
:data:`TRANSCRIPTION_TOPIC` does not carry.

Three facts keep it from being the whole rule, and all three are why the
quiet period survives underneath it rather than being replaced by it:

- **An agent that is not a LiveKit ``AgentSession`` publishes nothing
  here.** Egma reads the attribute where it is offered and requires it
  nowhere.
- **Fast transitions coalesce.** ``RoomIO`` cancels the in-flight
  attribute write before starting the next one, so a turn whose states
  change faster than one round trip to the server can publish only its
  last state — and where that last state is the one already published,
  nothing is published at all. So egma keys on the *arrival* of a
  finished state and never assumes it saw ``thinking`` or ``speaking``
  first.
- **A realtime-model agent never comes back at all under this setup.**
  The two generation paths in the agents SDK are not the same here: the
  pipeline one returns to ``listening`` off the state it is already in,
  and the realtime one guards that return with ``if audio_output is not
  None``. Both reach ``speaking`` on the first forwarded text, so an
  agent running a realtime model in a chat simulation — where the setup
  this driver asks for has audio output off — goes ``thinking`` →
  ``speaking`` and stops. The end-of-turn marker simply never fires, and
  the quiet period is the whole of the rule for that agent.

Read from LiveKit's documentation and from the agents SDK in this
checkout, and not yet observed on a live wire. That is the fourth reason
the fallback below is a real path rather than a formality, and together
they are why its value is the measured one rather than a tuned one.
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
    """One LiveKit room's coordinates, however egma came by them.

    Three shapes live in here, and they are three answers to one question:
    who minted the token that opens the room. Egma mints it from the
    project's key pair; or a ``tokenEndpoint`` means egma asks the customer
    for one; or a ``given_token`` means egma was handed one already — by a
    platform that opened the room itself, which is what a call created
    through somebody's API comes back as. The fields the other shapes use
    are left empty rather than absent, so everything below can ask
    :attr:`mints_its_own` once and read the rest plainly.
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
    """One room, made and dispatched into and deleted — whatever it carries.

    Everything about a LiveKit room that is the same whether the exchange
    in it is spoken or typed: coming by a token, creating the room,
    offering the mock-tool seam in it, asking for the worker, tearing it
    down, and every refusal and every scrubbing on the way. What a join
    *produces* is the one thing that differs, and that is what the two
    subclasses below are for.

    One instance per exchange, per simulation.
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
    ) -> None:
        self._settings = settings
        self._mock_tools = mock_tools
        self._endpoint_resolver = endpoint_resolver
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
        # A room egma opens itself is named by the driver conducting it,
        # because the name is a channel: the chat driver's rooms carry the
        # modality mark the customer's worker reads. A room egma asks for
        # a token into is named after the simulation, because the endpoint
        # being asked has to be able to check the name against its own
        # rules — and it carries the same mark, because the worker reads
        # the name however the token was minted. A room a platform opened
        # is **not named here at all**: it
        # has a name already, egma is never told it, and inventing one
        # would put a string in every log line that exists in nobody's
        # telemetry.
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

    def _answer_for_mocked_tools(self) -> None:
        """Stand ready to answer for the agent's tools, in the room.

        Done at the join itself, which is the earliest moment it can be
        done and the only one that is early enough. The agent's side says
        hello as its session starts, and on two of the three ways into a
        room nothing egma does decides when that session starts: the
        worker can already be in the room, mid-hello, while egma is still
        connecting. A method registered a step later than the connect is a
        race with the first thing the agent says, and losing it reads on
        the far side as "no egma here" — every real tool then runs inside
        a live simulation, and the record says nothing about it.

        Asked for twice, deliberately: once by the room the instant it is
        entered, and once from :meth:`dial` for a room that offers no such
        moment. Whichever call gets both methods on is the one that
        offers the exchange, and the other returns having done nothing.
        The flag that decides which is which is set only after both
        registrations return, so the second ask stays a real second
        chance: a room that refused at the join is a room the fallback
        can still offer in, and a flag raised before the work would spend
        that chance on nothing and leave every mocked tool running its
        own implementation for the whole simulation.

        Both methods go on whether or not this simulation mocks anything.
        A room where egma answers for no tools still answers the hello
        with an empty list, which is how the agent's side learns to wrap
        nothing and leave every tool alone — and it is what puts the
        agent's own tool list on the record, so a simulation that isolated
        nothing still says so.

        **Nothing here may sink a conversation that would otherwise have
        run.** Offering the methods is the one step in this driver that
        the simulation does not depend on: a room where egma answered for
        nothing is exactly the room every simulation was before mock tools
        existed, and failing the whole thing over it would make a feature
        nobody asked for on this connection into a way to lose a test run.
        So a refusal is logged loudly and the exchange is simply never
        offered — and the record then claims nothing about tools, which is
        the truth, because egma never stood in their path.
        """
        if self._mock_tools is None or self._room is None or self._offered:
            return
        try:
            self._room.register_rpc(HELLO_METHOD, self._mock_tools.hello)
            self._room.register_rpc(TOOL_METHOD, self._mock_tools.tool)
        except Exception as unoffered:
            logger.error(
                "Egma could not offer the mock-tool exchange in %s, so every "
                "tool the agent has will run its own implementation: %s",
                self._room_name,
                self._quotable(repr(unoffered)),
            )
            return
        self._offered = True

    async def _way_in(self) -> WayIn:
        """A token and a room, however this connection comes by them.

        Egma makes the room and signs its own token for it, or asks the
        customer's endpoint for one, or was handed one for a room a
        platform opened itself — and everything after this is the same
        whichever it was.
        """
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
        """Get the agent in.

        There is nothing to dial: who to reach is the room's own
        configuration, and asking for it is one explicit dispatch by the
        name the connection carries. Nothing here falls back on LiveKit's
        automatic dispatch: a room filled that way goes to whichever
        workers are listening, so the record could not name the agent it
        graded, and the test's job dispatch metadata would have no
        dispatch to ride.

        A connection that did not mint its own token asks for nothing here
        at all. Dispatching takes the key pair egma deliberately was not
        given, so putting a worker in the room is somebody else's job —
        the token endpoint's, which was asked for the worker by name in
        the token request and dispatches by minting a token that carries
        it, or the platform's that opened the room — and egma's part is to
        be in the room when it arrives.

        On two of the three ways in the agent may have arrived already,
        so the room is asked who is in it before anybody starts waiting
        for somebody to come.
        """
        if self._room is None:
            raise MediaBackendError("an agent was requested before a room transport")
        await self._room.wait_connected()
        self._answer_for_mocked_tools()
        self._room.note_anybody_already_here()
        if not self._settings.mints_its_own:
            return
        await self._dispatch()

    async def _wait_arrivals(self, seconds: float) -> bool:
        """Whether anybody joined the room inside the budget."""
        room = self._room
        if room is None:
            raise MediaBackendError("an agent was waited for before a room")
        return await first_of(room.arrivals, within=seconds)

    async def teardown(self) -> None:
        """Leave, and delete the room where egma has the power to.

        Deleting is what ends everything the room held — the dispatched
        worker included — so it is done however the exchange ended: a
        natural close, a limit, a cancel directive, or a fault at any step
        above. A room left running would go on costing the customer, and
        the one call that could have stopped it is this one.

        Every path where no room was ever asked for skips it, because a
        delete for a room nobody made could only fail — which is both
        shapes that were handed their token. A token minted to join one
        room carries no power to delete it, so egma leaves and the room
        stands empty. What closes it then is whoever opened it: the
        customer's own empty timeout on the room — which is why the
        hardening recipe asks for a short one on ``egma-sim-`` rooms — or
        the platform that made the room for its own call. Trying the
        delete anyway would spend a request to be refused and put a line
        in the log about a failure that was never a failure.
        """
        room, self._room = self._room, None
        try:
            if room is not None:
                await room.leave()
        finally:
            if self._asked_for_a_room:
                await self._delete_room()

    # -- The places this driver touches the network ---------------------------
    #
    # Making the room, dispatching into it, joining it, deleting it, and
    # asking a customer's endpoint for a token — and nothing else in this
    # file reaches anywhere. Gathered here so that a room-shaped fake
    # standing in for a LiveKit is these and no more: every wait above,
    # every ending, every sentence and every scrubbing is then the real
    # driver's, in CI as on a customer's server.
    #
    # The token request is the one CI does not stand in for. It goes to a
    # real HTTP server on loopback implementing the published contract, so
    # what is proved about the request egma sends and the answers it takes
    # is proved about the code, over a socket, rather than about a mock.

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
        """The body egma POSTs: LiveKit's standard token request, filled in.

        The same JSON every LiveKit client SDK sends to a token endpoint —
        ``room_name``, ``participant_identity``, ``participant_name`` and a
        ``room_config`` naming the agent to dispatch — so an endpoint written
        for the customer's own frontend serves egma unchanged. Two of egma's
        own rules ride on it: the room is always a fresh ``egma-sim-`` name,
        and the identity is always the persona's.

        ``participant_name`` carries the identity again on purpose. LiveKit
        keeps identity and display name apart, and endpoints written against
        egma's earlier contract read the display-name key as the identity;
        sending both keeps those working, and a standard endpoint gets a
        harmless display name out of it.

        ``room_config`` is always there, because the name is always demanded:
        one dispatch entry, the worker's name, and the test's own
        ``job_dispatch_metadata`` as that dispatch's metadata where the test
        wrote one — the same string the key-pair shape writes on the dispatch
        it makes itself. Nothing else of the simulation's — no scenario, no
        persona, no participant metadata or attributes — because an agent
        that reads its script stops being under test; the room's name is the
        whole of egma's signal.
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
        """Ask the customer's endpoint for a way into the room.

        One POST, one JSON object, and the answer read against the
        contract the docs publish — LiveKit's own: the token and the server
        under the names LiveKit's standard endpoint answers with, or the
        spellings the wild already uses. The server is required, because the
        endpoint is the one side that knows which of the customer's LiveKit
        projects this agent lives in, and the connection holds no address of
        its own.

        egma invents both names and sends them, so the endpoint can mint a
        token for exactly the identity egma will join as and exactly the
        room it will join, and can refuse anything else. Every way this
        can go wrong ends the simulation with a fault that names the status or
        broken contract part. Endpoint bodies and network exceptions are never
        customer-visible text.
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
        """Refuse a server the endpoint named that egma must not join.

        The answer decides where the simulator opens its next connection and
        sends the token it was just handed, so it is held to the rule the
        endpoint itself was held to. TLS, first: a ``ws://`` or ``http://``
        server would carry the token in the clear. Then nothing that
        resolves inside the deployment: a literal address is judged as
        written; a name is resolved through the resolver the token request
        went through, and every answer must be public — because an endpoint
        that is wrong, or compromised, or simply pointed at a staging server
        on the office network must not make egma a client of that network.

        The join itself is made by the LiveKit SDK on a socket of its own,
        so unlike the token request there is no socket factory here to hold
        the connected address to the checked one, and the SDK cannot be
        handed the checked address in place of the name: under TLS the name
        is what the server's certificate is checked against. So a name that
        moves between this lookup and the SDK's is not closed by pinning; it
        is closed by the scheme rule above. The token rides the WebSocket
        upgrade, which the SDK sends only once the peer has shown a
        certificate for the answered name, and a host inside the deployment
        holds no such certificate. What a moved name can still reach is one
        TCP connect and one failed handshake, reported as a join refusal;
        no token and no request body go with it. That is the residue, said
        here rather than implied away.
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
        self._room.answer_when_joined(self._answer_for_mocked_tools)
        return self._room.create_transport()

    async def wait_answered(self, seconds: float) -> str:
        """Wait for the agent to turn up and be heard, or say nobody did."""
        # One deadline for both halves, not one each: the budget is how
        # long the room may stand empty, and two budgets end up waiting
        # twice as long as anybody was told.
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
        )


# -- The room carrying typing ------------------------------------------------
#
# No Pipecat, no transport, no audio, and no text-to-speech anywhere: a
# chat simulation types onto one topic and reads the agent's own words
# back off another. What makes that possible without touching the
# customer's agent is that LiveKit's session already listens on the chat
# topic; what makes it *fast* is the six lines the customer adds, which
# read the modality off the name of the room this driver makes — the
# ``egma-sim-chat-`` mark — and stop the agent synthesising speech nobody
# hears.


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
    """Where this stream opened in the room's own order of streams.

    A turn is several utterances joined together, and they are joined in
    *this* order rather than in the order they finished arriving. The two
    are not the same order: a stream that opens first may close last, and
    when it did the agent's opening words landed behind the sentence that
    followed them and the record read as if the agent began mid-sentence.
    Arrival order is what the queue can offer; open order is what the
    agent actually said.
    """


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
    """When this turn's answer started, on the running loop's clock.

    The turn's finish line for ``turn_response_latency``. It is carried
    up rather than turned into a duration here because the starting line
    is the conversation loop's — the moment the persona's turn went out —
    and only one of the two ends is visible from inside this driver.

    ``None`` where the agent never began answering: a turn that only
    called a tool, or one that produced nothing at all.
    """


class TextRoom:
    """One LiveKit room joined for typing, with no media in it at all.

    The chat counterpart of :class:`egma_simulator.media.room.JoinedRoom`,
    and deliberately much smaller than it: there is no transport to build,
    no conversion, no pacing and no recording. Egma connects, subscribes
    to nothing, offers the mock-tool methods on its own participant, types
    on one topic and reads closed streams off another.

    What it exposes upward is five events and a queue, because that is the
    whole of what the wire says: somebody arrived, somebody published
    audio, the agent left, the room dropped egma, the agent said it has
    finished its turn — and, in order, every utterance that finished
    arriving.

    It also answers one question the queue cannot: which streams this room
    knows are still *open*. A queue holds what has finished; a turn that
    ends on what has finished alone throws away whatever had started and
    not landed, which is exactly how the agent's opening words once left
    the record.
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
        """When each turn's answer *started*, against the turn it started.

        The finish line of ``turn_response_latency``, and the only place
        on this lane that can see it. A stream's header is the first
        moment the wire says the agent is answering this question — before
        a word of it exists — and it is what a caller would hear as the
        agent beginning to reply. Everything after it is the answer being
        written and then egma deciding no more is coming, which is egma's
        own wait and not the agent's speed.

        Kept per turn rather than as one instant because a stream opening
        late still belongs to the turn it opened in, and the first stream
        of *this* turn is the one that answers it. Only the first is kept:
        a turn's later utterances are the same answer continuing.
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
        """Set when the agent's own state says it has finished a turn.

        Cleared where a turn begins, and cleared again by an utterance
        whose stream opened *after* that state arrived: that is the agent
        writing again, and the latch has to follow the words rather than
        outrank them. An utterance whose stream was already open when the
        state arrived clears nothing, because the state is about that very
        utterance — the words travel the data channel and the state the
        signalling one, and neither order is the wrong one.
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

    @property
    def joined(self) -> bool:
        return self._room is not None

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
            for publication in participant.track_publications.values():
                if getattr(publication, "kind", None) == rtc.TrackKind.KIND_AUDIO:
                    self.audio_published.set()

    def _watch(self, room: Any) -> None:
        """Put every handler this room reads the wire through onto it.

        Its own method rather than a block inside the join, because
        these six signatures *are* the wire: what LiveKit hands each
        event, and in what order, is the one thing here that cannot be
        derived from anything else, and a test that reaches past them
        proves nothing about the unpacking each one does. So a
        room-shaped fake registers through this and fires what it kept.

        Registered before the connect rather than after it, for the reason
        the mock-tool methods are: a worker already in the room can speak
        the moment egma becomes visible to it, and a handler attached
        afterwards is a race with the agent's first word.
        """
        from livekit import rtc

        room.register_text_stream_handler(TRANSCRIPTION_TOPIC, self._agent_said)

        @room.on("participant_connected")
        def _arrived(_participant: Any) -> None:
            self.arrivals.set()

        @room.on("participant_disconnected")
        def _left(_participant: Any) -> None:
            if not self._leaving:
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
        def _dropped(*_why: Any) -> None:
            # Egma losing the room is a fault, and it is not the agent
            # ending the exchange. Told apart here so the record cannot
            # read one as the other.
            if not self._leaving:
                self.failed.set()

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

    def register_rpc(self, method: str, handler: RpcMethod) -> None:
        """Offer one mock-tool method on egma's own participant.

        The same seam the voice room offers, through the same wrapper: the
        exchange knows nothing about rooms, and nothing about whether the
        conversation around it is spoken or typed.
        """
        if self._room is None:
            raise MediaBackendError(
                f"{method} was offered before the room was joined", ending=ERROR
            )
        self._room.local_participant.register_rpc_method(method, answering(handler))

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
        """The next finished utterance, or nothing inside the budget.

        Five things end the wait early and each one means nothing more is
        coming on its own: the utterance arriving, the agent leaving, the
        server dropping egma, an audio track appearing, and the agent's
        own state saying it has finished. Neither of the middle two is an
        answer at all — a room egma has been dropped from has nothing
        left to say, and a track is the wire saying this agent is
        speaking — and there is no point waiting out a quiet period for
        words that are not coming or that will arrive at speech pace.

        ``finished_ends_it`` is off until the turn has heard something,
        and that is deliberate rather than defensive. A session publishes
        ``listening`` when it *starts*, before it has been asked anything
        and before it greets anybody, so a turn that took a finished state
        as an answer would end the greeting before the agent opened its
        mouth. Waiting for the first word is a different question from
        waiting for the next one, and the caller pays a different budget
        for it; the state signal only answers the second.

        Returning ``None`` never means the turn is over on its own. It
        means nothing more will *arrive* on its own — the caller still
        owes this turn every stream it opened and has not seen close.
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
        for reader in list(self._reading):
            if not reader.done():
                reader.cancel()
        self._reading.clear()
        if room is None:
            return
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
        """Take the agent's own word for where it is in its turn.

        Dropped for egma's own participant for the reason its own words
        are dropped one method up: nothing egma publishes about itself is
        the agent saying anything.

        Only a *finished* state does anything, and it only ever sets the
        latch. Nothing here waits for ``thinking`` or ``speaking`` first,
        because the platform is free to publish neither: it cancels an
        attribute write that a faster transition overtakes, so a quick
        turn can announce only where it ended up.
        """
        if identity == PERSONA_IDENTITY:
            return
        state = changed.get(AGENT_STATE_ATTRIBUTE)
        if state is None:
            return
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
        """Let this turn's still-open streams finish, for a bounded while.

        The bound is what keeps one stalled stream from holding a whole
        simulation, and :meth:`streams_open_in` is what the caller asks
        afterwards to find out whether the bound is what ended the wait.

        Waited on with :func:`asyncio.wait` rather than gathered, because
        a gather that times out cancels what it was waiting for. A reader
        cancelled here would lose its words *and* its line in the log —
        and a dropped utterance nobody can see is the whole shape of the
        defect this rule exists to end.
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

    async def wait_arrived(self, seconds: float) -> str:
        """Wait for the agent's participant, or say nobody came.

        One half here where the voice driver waits for two. A chat agent
        publishes no audio *by design*, so there is no second signal to
        wait on — and waiting for one would refuse every correctly
        integrated worker as a worker that crashed.
        """
        if not await self._wait_arrivals(seconds):
            raise MediaBackendError(
                self._nobody_came(seconds), ending=AGENT_NEVER_JOINED
            )
        return self._room_name

    async def wait_greeting(
        self, seconds: float, *, quiet_seconds: float, drain_seconds: float
    ) -> AgentTurn:
        """What the agent opens with, if it opens with anything.

        A turn with no words in it is the ordinary answer here: plenty of
        agents wait to be spoken to, and the conversation loop then has the persona
        open. The budget is separate from the quiet period because a
        greeting is a whole model round trip after a session starts, where
        a quiet period is the gap between two things already being said.

        The greeting is also the one turn the agent's own state cannot
        end. A session publishes ``listening`` the moment it starts, which
        is before it has greeted anybody — so here that state means ready,
        never finished, and only the first word egma hears turns the
        signal on.
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
        """Type one persona turn in, and read the agent's answer back.

        Two budgets, because they measure two different things. Waiting for
        the answer to *start* is waiting on a whole model round trip, and
        possibly a tool call inside it; waiting for the answer to *continue*
        is the gap between two utterances of one turn that is already under
        way. Giving the first the second's budget would call a thinking
        agent silent.

        Only what this turn opened counts as this turn's answer. A stream
        that opened before the question went out is answering an earlier
        prompt — a greeting that outran its wait included — however late
        it finishes, and is left off the record instead of filed under a
        question it was never asked. That is why the send comes first and
        the turn begins the moment it returns: the two run in one step of
        the event loop, with no await between them, so there is no moment
        at which a stream could open after the question left and still be
        stamped with the turn before it. A stream that opens while the
        text is still leaving egma is stamped with the old turn, because
        nothing that had not yet arrived can have prompted it.
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

    async def _assembled(
        self,
        *,
        first_within: float,
        quiet: float,
        drain: float,
        turn: int,
        silence_ends_it: bool = False,
    ) -> AgentTurn:
        """One agent turn, out of however many utterances it took.

        An utterance ends when its stream closes. The *turn* ends when two
        separate things hold together, and either one alone gets a turn
        wrong.

        **The agent has to be finished.** It says so itself: a LiveKit
        session publishes :data:`AGENT_STATE_ATTRIBUTE` and its return to
        a finished state is the end of the whole turn, the tool call
        inside it included. Where that never arrives — an agent that is
        not a LiveKit session, or a turn whose state changes coalesced
        into a publish that changed nothing — the room going quiet for the
        whole quiet period says the same thing less certainly, and the
        agent leaving says it for good. An agent that says a filler, calls
        a tool and then answers is one turn that arrived in pieces, and a
        rule that stopped at the first close would put the filler on the
        record and the answer nowhere.

        **And every stream this turn opened has to have closed.** Neither
        a finished state nor a spent quiet period ends a turn while a
        stream stamped with it is still open. That is not a refinement: a
        stream is stamped when it *opens*, so one that opens promptly and
        finishes late still belongs to the question it began answering —
        and a turn that ended on what had already arrived threw those
        words away, because the next turn then refuses them for being
        older. The record read as if the agent began
        mid-sentence, with nothing on it saying a word had gone. The wait
        is bounded, because one stalled stream must not hold a whole
        simulation; when the bound is what ends it, the log says so and
        names the time it really spent. The bound is per stream and not
        per turn: every utterance of this turn that lands starts it
        again, because what it measures is the writing of one utterance
        the agent has already begun, and a turn that arrives in several
        slow pieces is an agent writing rather than an agent stalled.

        Two things keep that wait from being entered at all, and neither
        of them is a turn being recorded: an audio track in the room,
        which is the wire saying this agent is speaking and is refused
        above this driver at its first output, and the server dropping
        egma, which raises below this loop. Both are read before the
        wait starts, because entering it in either case would spend a
        bound on a turn nothing will read. Neither shortens a wait
        already under way: once the drain is running it watches this
        turn's readers and nothing else.

        The turn's utterances are joined in the order their streams
        *opened*, which is the order the agent said them. Arrival order is
        what a queue can offer and it is not the same order.

        ``silence_ends_it`` is what keeps a delivered turn from running on
        into a question egma can no longer answer honestly. A stream is
        stamped when it opens, so one that opens *before* the next question
        goes out can always be told from that question's answer — but one
        that has not opened at all by then cannot. There is no marker for
        it and no rule that could invent one, so the exchange stops where
        the ambiguity would begin rather than filing a guess. The greeting
        never passes it: nothing has been asked yet, so quiet there is an
        agent waiting to be spoken to.
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
