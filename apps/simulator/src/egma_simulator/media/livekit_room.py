"""The livekit-room driver: the agent's own room, joined and dispatched into.

The agent under test lives in a LiveKit room. So egma gets into one — in
the *customer's* LiveKit project, not the deployment's — as an ordinary
participant, gets the agent's worker into it, holds the exchange, and
tidies up when it is over. That is the whole of this file, in the four
verbs every media driver has (see :mod:`egma_simulator.media`):

1. ``create_session`` — come by a token and a room, and join purely
   outbound through Pipecat's stock transport. The simulator needs no
   inbound network surface: it opens the websocket and negotiates the
   media.
2. ``dial`` — get the agent in. A connection that names an agent gets an
   **explicit dispatch** by that name; one that names none relies on
   **automatic dispatch**, which is LiveKit's own behavior for a worker
   registered without a name: it is given every new room in the project,
   so egma creating the room is the whole of the request.
3. ``wait_answered`` — the agent's participant arrives and its audio
   flows, within a bounded wait. Both halves matter: a participant that
   joins and publishes nothing is a worker that crashed on its first
   frame, and an exchange conducted against it would grade an agent that
   never spoke.
4. ``teardown`` — leave, and delete the room where egma has the power to.
   Deleting is what ends everything the room held, including a dispatched
   worker.

## The two ways in

Step 1 is where the connection's two shapes differ, and they differ over
one question: who mints the token that opens the room.

- **egma mints it.** The connection carries the project's ``apiKey`` and
  ``apiSecret``. egma creates a fresh ``egma-sim-``-prefixed room, signs a
  token that opens that room and nothing else, dispatches the worker, and
  deletes the room at the end.
- **The customer mints it.** The connection names a ``tokenEndpoint``
  instead, and the secret that signs tokens for their whole project never
  leaves their side. egma invents the room and participant names, POSTs
  them, and joins with the token that comes back. It holds no key pair, so
  it cannot dispatch — that is the endpoint's job, and the reason a room
  nobody joined gives says so — and it cannot delete, so it leaves the
  room for the customer's own empty timeout to close.

Above :class:`WayIn` the two are one code path. Everything after "a token
and a room name exist" — joining, waiting, conducting, leaving — is the
same code either way, which is what keeps the second shape from being a
second driver.

Two deliberate differences from the driver that places a phone call:

- **Configuration arrives from the spec's connection block**, never from
  this deployment's environment. The room is the customer's: their
  LiveKit project, their key pair, their agent. A trunk belongs to a
  deployment and a room does not, so nothing in this file reads an
  environment variable.
- **"Dial" means dispatch, not SIP.** Nothing is called; a worker is
  asked for.

## The two metadata channels

Platform integrations have taught agents to expect two, and they carry
different things:

- **Room metadata** is the connection's own configured JSON, verbatim.
  It is the customer's to write and egma's to pass through untouched —
  the place an agent reads whatever its own deployment needs.
- **Dispatch metadata** is egma's context and only egma's: which
  simulation this room is conducting, the modality it is in, who egma is
  in the room, and which version of the mock-tool exchange that
  participant speaks. It carries **nothing of the test's content** — no
  scenario text, no persona, no expected behavior, and no mock answer —
  because an agent that reads its script stops being under test.

## Answering for the agent's tools

A room driver is also where egma stands in the agent's tool path, for the
simulations that mock anything. The two methods are registered on egma's
participant the moment the room is joined, and what answers them knows
nothing about rooms — see :mod:`egma_simulator.mock_tools`, which owns
the exchange, the record it leaves, and the coverage stamp. Room
membership is the whole of the authorisation, which is why a room with no
egma participant leaves the agent's tools untouched by construction.

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
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from ..contract import AGENT_NEVER_JOINED, ERROR
from ..mock_tools import (
    HELLO_METHOD,
    PROTOCOL_VERSION,
    TOOL_METHOD,
    MockToolSeam,
)
from ..redaction import SecretRegistry
from . import MediaBackendError
from .room import (
    PERSONA_IDENTITY,
    QUOTED_REFUSAL_CHARS,
    JoinedRoom,
    RoomSession,
    delete_room,
    first_of,
    fresh_room_name,
    persona_name_for,
    room_name_for,
    room_token,
)

logger = logging.getLogger(__name__)

ROOM_BAND_HZ = 16000
"""The band an exchange in a room is carried at.

WebRTC negotiates its own codec and Pipecat's transport resamples what
arrives to the band the pipeline was assembled at, so this is the band
that really flows through egma — wideband, where a phone call is
narrowband. What a record stamps is still measured off the audio the
recorder saw, never copied from here, and there is no way for a
connection to ask for another: a band that could be asked for would be a
band declared.
"""

KNOWN_CONFIG_KEYS = frozenset({"url", "agentName", "metadata"})
KNOWN_CREDENTIAL_KEYS = frozenset({"apiKey", "apiSecret"})
URL_SCHEMES = ("ws://", "wss://", "http://", "https://")

ENDPOINT_CONFIG_KEYS = frozenset({"url", "tokenEndpoint"})
"""What the second shape's config holds — and what it does not.

No agent name and no room metadata, because both are powers a key pair
buys: nothing here can dispatch a worker or create the room that would
carry the metadata. A key the driver would read and quietly do nothing
with is worse than one it refuses by name.
"""

ENDPOINT_CREDENTIAL_KEYS = frozenset({"headers"})
ENDPOINT_SCHEMES = ("http://", "https://")

TOKEN_ALIASES = ("token", "participantToken", "accessToken")
"""The three names a minted token comes back under.

All three are accepted because all three are in the wild: teams that
already run a token endpoint for their own web client should be able to
point egma at the one they have rather than write a second one for egma.
The first of these that carries a string is the token.
"""

TOKEN_SECONDS = 20.0
"""How long the endpoint has to answer before it counts as unreachable.

Short of the wait for the agent itself, so a slow endpoint reads as a slow
endpoint rather than as a worker that never came.
"""

QUOTED_ENDPOINT_CHARS = 200
"""How much of an endpoint's answer is quoted back into a reason.

Enough to carry a framework's own error page heading or a JSON error
message, short of pasting a page of HTML into a simulation's record.
"""


def dispatch_metadata(simulation_id: str, *, egma_identity: str) -> str:
    """egma's context for one dispatched worker, and nothing else's.

    Four facts, and every one of them is about *where egma is*, never
    about what the test asks:

    - ``simulationId`` — which simulation this room is conducting, so an
      agent can line its own telemetry up with egma's record.
    - ``modality`` — that it is a voice one.
    - ``egmaIdentity`` — who egma is in this room. It is the address the
      agent's side sends a mock-tool call to, and it is the whole of the
      authorisation: a room with no such participant has nobody to ask,
      which is every production room.
    - ``protocolVersion`` — which version of that exchange egma speaks,
      so the other side knows before it says anything.

    **Nothing of the test's content, ever.** No scenario, no persona, no
    expected behavior, and no mock answer — an answer reaches the agent
    only at the moment it calls the tool, because an agent that could read
    its script would stop being under test.
    """
    return json.dumps(
        {
            "simulationId": simulation_id,
            "modality": "voice",
            "egmaIdentity": egma_identity,
            "protocolVersion": PROTOCOL_VERSION,
        },
        separators=(",", ":"),
    )


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
    """One LiveKit room's coordinates, as a connection block spells them.

    Two shapes live in here, and which one a connection is in is decided
    by one config key: a ``tokenEndpoint`` means egma asks the customer
    for its way into the room instead of minting one. The fields the other
    shape uses are left empty rather than absent, so everything below can
    ask :attr:`mints_its_own` once and read the rest plainly.
    """

    url: str
    """The customer's LiveKit, ``ws``/``wss`` or ``http``/``https``."""

    api_key: str = ""
    api_secret: str = field(default="", repr=False)

    agent_name: str = ""
    """Which agent to dispatch. Empty means automatic dispatch."""

    metadata: str | None = None
    """The connection's configured JSON, as the room's metadata carries
    it. ``None`` where the connection configured none."""

    token_endpoint: str = ""
    """Where egma asks for a token, once per simulation. Empty on the
    shape that mints its own."""

    endpoint_headers: dict[str, str] = field(
        default_factory=dict, repr=False
    )
    """What egma sends to authenticate itself to that endpoint. Empty
    where the endpoint takes no credential, which the docs advise against
    and a private network sometimes makes true."""

    @property
    def mints_its_own(self) -> bool:
        """Whether egma holds the key pair that signs its own tokens.

        The whole difference between the two shapes, asked once. Where it
        is false egma has a token and nothing else: no room to create, no
        worker to dispatch, and no room to delete when it is over.
        """
        return not self.token_endpoint

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
            for held in (self.api_secret, *self.endpoint_headers.values())
            if held
        )

    @classmethod
    def from_connection(
        cls, config: dict[str, Any], credentials: Any
    ) -> RoomSettings:
        """Read one connection block, or refuse it in a sentence.

        Everything a room needs is here and nothing is looked up, which
        is what makes a connection that cannot be used an honest refusal
        before anything is reached rather than a failure part-way through
        an exchange.
        """
        if config.get("tokenEndpoint") is not None:
            return cls._at_an_endpoint(config, credentials)

        unknown = set(config) - KNOWN_CONFIG_KEYS
        if unknown:
            raise MediaBackendError(
                f"a livekit connection does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(KNOWN_CONFIG_KEYS)}"
            )

        url = _server_url(config)

        agent_name = config.get("agentName", "")
        if agent_name is None:
            agent_name = ""
        if not isinstance(agent_name, str):
            raise MediaBackendError("livekit config: agentName must be a string")

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
            metadata=_configured_json(config.get("metadata")),
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
                f"a livekit connection that names a tokenEndpoint holds no "
                f"key pair, so it can neither dispatch an agent nor carry "
                f"room metadata; config key(s) {sorted(unknown)} are read by "
                f"nobody. It knows {sorted(ENDPOINT_CONFIG_KEYS)}"
            )

        url = _server_url(config)

        endpoint = config["tokenEndpoint"]
        if not isinstance(endpoint, str) or not endpoint.strip():
            raise MediaBackendError(
                "livekit config: tokenEndpoint must be a non-empty string — "
                "where Egma asks the customer for a token"
            )
        endpoint = endpoint.strip()
        if not endpoint.startswith(ENDPOINT_SCHEMES):
            raise MediaBackendError(
                f"livekit config: tokenEndpoint is where Egma posts a "
                f"request, so it must start with one of "
                f"{', '.join(ENDPOINT_SCHEMES)}; got {endpoint!r}"
            )

        return cls(
            url=url,
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


def _endpoint_headers(credentials: Any) -> dict[str, str]:
    """What egma sends to authenticate itself to a token endpoint.

    Absent is a whole answer: an endpoint on a private network can be open
    to egma alone. What is not a whole answer is something egma cannot
    send — a refusal here names the field and never quotes the value,
    because the values are the credential.
    """
    if credentials is None:
        return {}
    if not isinstance(credentials, dict):
        raise MediaBackendError(
            "a livekit connection that names a tokenEndpoint carries that "
            "endpoint's auth headers, or nothing at all"
        )
    if not credentials:
        return {}

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


def _tokens_in(said: str) -> list[str]:
    """Every token-shaped value an endpoint's answer carries.

    Tolerant on purpose: this is handed whatever came back, including an
    exception's repr and somebody's HTML error page, and anything it
    cannot read as a JSON object simply holds no token to protect.
    """
    try:
        held = json.loads(said)
    except ValueError:
        return []
    if not isinstance(held, dict):
        return []
    return [
        held[alias]
        for alias in TOKEN_ALIASES
        if isinstance(held.get(alias), str) and held[alias].strip()
    ]


def _configured_json(configured: object) -> str | None:
    """The connection's configured metadata, passed through byte for byte.

    The control plane only ever stores this as a JSON object in a string,
    so a string is the customer's own JSON and rides through verbatim.
    Anything else never came through the door, and is a mistake worth
    naming rather than passing on.
    """
    if configured is None:
        return None
    if isinstance(configured, str):
        return configured
    raise MediaBackendError(
        "livekit config: metadata rides to the agent exactly as configured, "
        "and it is configured as a JSON object in a string"
    )


@dataclass(frozen=True)
class WayIn:
    """A token and the server it opens — everything a join needs.

    The seam between the two shapes. Above it the exchange is one code
    path: joining, waiting, conducting and leaving do not care whether
    egma signed the token itself or was handed one.
    """

    url: str
    token: str = field(repr=False)


class LiveKitRoomBackend:
    """One exchange in one room, per instance."""

    def __init__(
        self,
        *,
        settings: RoomSettings,
        band_hz: int,
        simulation_id: str,
        mock_tools: MockToolSeam | None = None,
    ) -> None:
        self._settings = settings
        self._band_hz = band_hz
        self._simulation_id = simulation_id
        self._mock_tools = mock_tools
        # One registry per driver, so what this driver quotes from the
        # platform goes through the same scrubbing a log line does rather
        # than through a second implementation of it.
        self._secrets = SecretRegistry()
        self._secrets.register(list(settings.secrets))
        # A room egma opens itself is named after nothing, because nobody
        # else has to recognise it. A room egma asks for a token into is
        # named after the simulation, because the endpoint being asked has
        # to be able to check the name against its own rules.
        self._room_name = (
            fresh_room_name()
            if settings.mints_its_own
            else room_name_for(simulation_id)
        )
        self._participant_name = persona_name_for(simulation_id)
        self._room: JoinedRoom | None = None
        self._asked_for_a_room = False

    @property
    def room_name(self) -> str:
        """The room this exchange is conducted in — one room, one
        simulation, and what the report carries as the provider
        reference."""
        return self._room_name

    async def create_session(self) -> RoomSession:
        """Get a way into the room, join it, and answer with its audio."""
        way_in = await self._way_in()
        self._room = self._joined_room(way_in)
        session = await self._room.join()
        self._answer_for_mocked_tools()
        return session

    def _answer_for_mocked_tools(self) -> None:
        """Stand ready to answer for the agent's tools, in the room.

        Done the moment the room is joined and before the worker is asked
        for, because the agent's side says hello as its session starts —
        a handler registered afterwards would be a race with the first
        thing the agent does.

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
        if self._mock_tools is None or self._room is None:
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
        self._mock_tools.standing_ready()

    async def _way_in(self) -> WayIn:
        """A token and a room, however this connection comes by them.

        Either egma makes the room and signs its own token for it, or it
        asks the customer's endpoint for one — and everything after this
        is the same either way.
        """
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
        configuration. A named agent is dispatched explicitly; an unnamed
        one is already on its way, because LiveKit gives every new room in
        a project to workers registered without a name — so creating the
        room *was* the request, and there is nothing more to ask for.

        A connection that asks an endpoint for its tokens asks for nothing
        here at all. Dispatching takes the key pair egma deliberately was
        not given, so putting a worker in the room is the endpoint's job
        and egma's part is to be in the room when it arrives.
        """
        if not self._settings.mints_its_own:
            return
        if not self._settings.agent_name:
            return
        await self._dispatch()

    async def wait_answered(self, seconds: float) -> str:
        """Wait for the agent to turn up and be heard, or say nobody did."""
        room = self._room
        session = None if room is None else room.session
        if room is None or session is None:
            raise MediaBackendError("an agent was waited for before a room")

        # One deadline for both halves, not one each: the budget is how
        # long the room may stand empty, and two budgets end up waiting
        # twice as long as anybody was told.
        deadline = asyncio.get_running_loop().time() + seconds
        if not await first_of(room.arrivals, within=seconds):
            raise MediaBackendError(
                self._nobody_came(seconds), ending=AGENT_NEVER_JOINED
            )
        left = deadline - asyncio.get_running_loop().time()
        if left <= 0 or not await first_of(session.carrying_audio, within=left):
            raise MediaBackendError(
                f"an agent joined the room but published no audio within "
                f"{seconds:.0f}s; check that the worker publishes a track "
                "rather than only subscribing",
                ending=AGENT_NEVER_JOINED,
            )
        return self._room_name

    async def teardown(self) -> None:
        """Leave, and delete the room where egma has the power to.

        Deleting is what ends everything the room held — the dispatched
        worker included — so it is done however the exchange ended: a
        natural close, a limit, a cancel directive, or a fault at any step
        above. A room left running would go on costing the customer, and
        the one call that could have stopped it is this one.

        Two paths skip it. One is where no room was ever asked for,
        because a delete for a room nobody made could only fail. The other
        is the connection that asks an endpoint for its tokens: a token
        minted to join one room carries no power to delete it, so egma
        leaves and the room stands empty. What closes it then is the
        customer's own empty timeout on the room — which is why the
        hardening recipe asks for a short one on ``egma-sim-`` rooms.
        Trying the delete anyway would spend a request to be refused and
        put a line in the log about a failure that was never a failure.
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
        """One `CreateRoom`, carrying the connection's own metadata."""
        from livekit import api

        request = api.CreateRoomRequest(name=self._room_name)
        if self._settings.metadata is not None:
            request.metadata = self._settings.metadata
        await self._asked(request, "the room could not be created")

    async def _dispatch(self) -> None:
        """One `CreateAgentDispatch`, carrying egma's context and no more."""
        from livekit import api

        request = api.CreateAgentDispatchRequest(
            room=self._room_name,
            agent_name=self._settings.agent_name,
            # The identity the token grants, not a name invented here: the
            # agent's side addresses its mock-tool calls to exactly this
            # participant, so a metadata block naming anybody else would
            # send them to nobody. Dispatching happens only on the shape
            # that mints its own token, which is the shape that signs this
            # identity — see `room_token`.
            metadata=dispatch_metadata(
                self._simulation_id, egma_identity=PERSONA_IDENTITY
            ),
        )
        await self._asked(
            request,
            f"the agent {self._settings.agent_name!r} could not be dispatched",
        )

    async def _token_from_endpoint(self) -> WayIn:
        """Ask the customer's endpoint for a way into the room.

        One POST, one JSON object, and the answer read against the
        contract the docs publish: the token under any of three names the
        wild already uses, and an optional ``serverUrl`` that overrides
        where the join goes — for the deployment whose endpoint knows
        which of several LiveKit projects this agent lives in.

        egma invents both names and sends them, so the endpoint can mint a
        token for exactly the identity egma will join as and exactly the
        room it will join, and can refuse anything else. Every way this
        can go wrong ends the simulation with a fault quoting whoever said
        so, scrubbed of the headers egma sent them.
        """
        import aiohttp

        endpoint = self._settings.token_endpoint
        asked = {
            "room_name": self._room_name,
            "participant_name": self._participant_name,
        }

        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=TOKEN_SECONDS)
            ) as session, session.post(
                endpoint,
                json=asked,
                headers=self._settings.endpoint_headers,
                # A token endpoint answers; it does not send egma somewhere
                # else. Following a redirect would carry the customer's own
                # auth headers to a host they never configured, chosen by
                # whoever answered — so a redirect is read as the answer it
                # is, and quoted like any other unexpected status.
                allow_redirects=False,
            ) as answer:
                status = answer.status
                said = await answer.text()
        except Exception as unreachable:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} could not be reached — "
                f"{self._quotable_endpoint(repr(unreachable))}",
                ending=ERROR,
            ) from unreachable

        if status < 200 or status >= 300:
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered {status} — "
                f"{self._quotable_endpoint(said)}",
                ending=ERROR,
            )

        token, server_url = self._minted(endpoint, said)
        # The endpoint's own answer wins where it names one: it knows which
        # of the customer's projects this agent lives in, and the config's
        # url is what egma falls back on when it says nothing.
        return WayIn(url=server_url or self._settings.url, token=token)

    def _minted(self, endpoint: str, said: str) -> tuple[str, str]:
        """The token and the server URL out of one answer, or a refusal.

        A body outside the contract is a fault worth naming precisely,
        because the fix is a line in somebody's own handler: what came
        back is quoted so they can see what their endpoint really said.
        """
        try:
            held = json.loads(said)
        except ValueError:
            held = None

        if not isinstance(held, dict):
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered something that is "
                f"not a JSON object — {self._quotable_endpoint(said)}",
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
                f"reads one from {', '.join(TOKEN_ALIASES)} — "
                f"{self._quotable_endpoint(said)}",
                ending=ERROR,
            )

        # From here the token is a credential like any other on this
        # connection: it opens a room in the customer's project, and it is
        # registered before anything else can quote it. Everything below
        # quotes the *whole* answer back — that is what makes a handler's
        # own mistake fixable — and the answer it quotes contains this
        # token. Registered late is registered too late: a refusal about a
        # bad serverUrl would carry a working credential into a reason, a
        # log line and the traceback under it.
        self._secrets.register([token])

        server_url = held.get("serverUrl", "")
        if not isinstance(server_url, str):
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered a serverUrl that "
                f"is not a string — {self._quotable_endpoint(said)}",
                ending=ERROR,
            )
        server_url = server_url.strip()
        if server_url and not server_url.startswith(URL_SCHEMES):
            raise MediaBackendError(
                f"the token endpoint at {endpoint} answered a serverUrl Egma "
                f"cannot join: it must start with one of "
                f"{', '.join(URL_SCHEMES)} — {self._quotable_endpoint(said)}",
                ending=ERROR,
            )
        return token.strip(), server_url

    def _joined_room(self, way_in: WayIn) -> JoinedRoom:
        """The way into the room, with a token that opens it and nothing
        else: one room, one identity, for the length of one simulation."""
        return JoinedRoom(
            url=way_in.url,
            token=way_in.token,
            room_name=self._room_name,
            band_hz=self._band_hz,
            quotable=self._quotable,
        )

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
        if not self._settings.mints_its_own:
            # Whose job it was, said plainly. egma asked for a token and
            # joined with it; it holds no key pair, so it could not have
            # dispatched anybody and is not what went wrong here.
            return (
                f"no agent joined {self._room_name} within {seconds:.0f}s — the "
                f"token endpoint minted a token and Egma joined the room with "
                f"it, but nothing dispatched the agent. A connection that "
                f"names a token endpoint hands Egma no key pair, so Egma "
                f"cannot dispatch: putting a worker in the room it was asked "
                f"for a token into is the endpoint's own job"
            )
        who = (
            f"no agent named {self._settings.agent_name!r} joined"
            if self._settings.agent_name
            else "no agent joined"
        )
        where = (
            "check that a worker registered under that name is running"
            if self._settings.agent_name
            else "check that a worker is running and registered for automatic "
            "dispatch, or name the agent on the connection"
        )
        return f"{who} the room within {seconds:.0f}s — {where}"

    def _quotable(self, told: str) -> str:
        """Somebody else's words, minus this connection's secret, short
        enough to read. A server that echoed the api secret back must not
        get it repeated into a reason or into the traceback under one."""
        return self._secrets.redact(told)[:QUOTED_REFUSAL_CHARS]

    def _quotable_endpoint(self, told: str) -> str:
        """The same, for an endpoint's answer rather than a platform's.

        Its own budget because what comes back from somebody's own handler
        is often an HTML error page rather than a sentence, and the useful
        part of one is at the top.

        It also registers any token the answer carries before redacting,
        and that ordering is the point rather than tidiness. An endpoint
        that *failed* may still have minted a working credential — a 500
        with a token in its body, or a redirect carrying one — and those
        answers are quoted from branches that run long before anything
        reads a token out of them. Registering here rather than at each
        branch means every path that can quote an endpoint, now or later,
        is covered by the one door it already goes through.
        """
        self._secrets.register(_tokens_in(told))
        return self._secrets.redact(told).strip()[:QUOTED_ENDPOINT_CHARS]
