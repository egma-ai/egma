"""The livekit-room driver: the agent's own room, joined and dispatched into.

The agent under test lives in a LiveKit room. So egma makes one — in the
*customer's* LiveKit project, not the deployment's — joins it as an
ordinary participant, gets the agent's worker into it, holds the exchange,
and deletes the room when it is over. That is the whole of this file, in
the four verbs every media driver has (see :mod:`egma_simulator.media`):

1. ``create_session`` — create a fresh ``egma-sim-``-prefixed room, mint a
   token that opens that room and nothing else, and join purely outbound
   through Pipecat's stock transport. The simulator needs no inbound
   network surface: it opens the websocket and negotiates the media.
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
4. ``teardown`` — leave and delete the room, whatever happened. Deleting
   is what ends everything the room held, including a dispatched worker.

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
- **Dispatch metadata** is egma's context and only egma's: the simulation
  this room is conducting and the modality it is in. It carries **nothing
  of the test's content** — no scenario, no persona, no expectation —
  because an agent that reads its script stops being under test.

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

import contextlib
import json
from dataclasses import dataclass, field
from typing import Any

from ..contract import AGENT_NEVER_JOINED, ERROR
from ..redaction import SecretRegistry
from . import MediaBackendError
from .room import (
    QUOTED_REFUSAL_CHARS,
    JoinedRoom,
    RoomSession,
    delete_room,
    first_of,
    fresh_room_name,
    room_token,
)

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


def dispatch_metadata(simulation_id: str) -> str:
    """egma's context for one dispatched worker, and nothing else's.

    The simulation this room is conducting and the modality it is in —
    enough for an agent to line its own telemetry up with egma's record,
    and nothing at all about what the test is going to ask it. An agent
    that could read its script would stop being under test.
    """
    return json.dumps(
        {"simulationId": simulation_id, "modality": "voice"}, separators=(",", ":")
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
    """One LiveKit room's coordinates, as a connection block spells them."""

    url: str
    """The customer's LiveKit, ``ws``/``wss`` or ``http``/``https``."""

    api_key: str
    api_secret: str = field(repr=False)

    agent_name: str = ""
    """Which agent to dispatch. Empty means automatic dispatch."""

    metadata: str | None = None
    """The connection's configured JSON, as the room's metadata carries
    it. ``None`` where the connection configured none."""

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every secret these settings hold, for redaction. One place to
        ask, so a second one arriving cannot fall out of the scrubbing."""
        return (self.api_secret,)

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
        unknown = set(config) - KNOWN_CONFIG_KEYS
        if unknown:
            raise MediaBackendError(
                f"a livekit connection does not know config key(s) "
                f"{sorted(unknown)}; it knows {sorted(KNOWN_CONFIG_KEYS)}"
            )

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


def _configured_json(configured: object) -> str | None:
    """The connection's configured metadata, as one string for the room.

    A string is the customer's own JSON and goes through byte for byte;
    an object or a list is written out compactly. Anything else was a
    mistake worth naming rather than passing on.
    """
    if configured is None:
        return None
    if isinstance(configured, str):
        return configured
    if isinstance(configured, dict | list):
        return json.dumps(configured, separators=(",", ":"))
    raise MediaBackendError(
        "livekit config: metadata is what the room carries for the agent, "
        "so it has to be a JSON object, a list, or a string of JSON"
    )


class LiveKitRoomBackend:
    """One exchange in one room, per instance."""

    def __init__(
        self,
        *,
        settings: RoomSettings,
        band_hz: int,
        simulation_id: str,
    ) -> None:
        self._settings = settings
        self._band_hz = band_hz
        self._simulation_id = simulation_id
        # One registry per driver, so what this driver quotes from the
        # platform goes through the same scrubbing a log line does rather
        # than through a second implementation of it.
        self._secrets = SecretRegistry()
        self._secrets.register(list(settings.secrets))
        self._room_name = fresh_room_name()
        self._room: JoinedRoom | None = None

    @property
    def room_name(self) -> str:
        """The room this exchange is conducted in — one room, one
        simulation, and what the report carries as the provider
        reference."""
        return self._room_name

    async def create_session(self) -> RoomSession:
        """Make the room, then join it, and answer with its audio."""
        await self._create_room()
        self._room = self._joined_room()
        return await self._room.join()

    async def dial(self) -> None:
        """Get the agent in.

        There is nothing to dial: who to reach is the room's own
        configuration. A named agent is dispatched explicitly; an unnamed
        one is already on its way, because LiveKit gives every new room in
        a project to workers registered without a name — so creating the
        room *was* the request, and there is nothing more to ask for.
        """
        if not self._settings.agent_name:
            return
        await self._dispatch()

    async def wait_answered(self, seconds: float) -> str:
        """Wait for the agent to turn up and be heard, or say nobody did."""
        room = self._room
        session = None if room is None else room.session
        if room is None or session is None:
            raise MediaBackendError("an agent was waited for before a room")

        if not await first_of(room.arrivals, within=seconds):
            raise MediaBackendError(
                self._nobody_came(seconds), ending=AGENT_NEVER_JOINED
            )
        if not await first_of(session.carrying_audio, within=seconds):
            raise MediaBackendError(
                f"an agent joined the room but published no audio within "
                f"{seconds:.0f}s; check that the worker publishes a track "
                "rather than only subscribing",
                ending=AGENT_NEVER_JOINED,
            )
        return self._room_name

    async def teardown(self) -> None:
        """Leave and delete the room, from any state and on every path.

        Deleting is what ends everything the room held — the dispatched
        worker included — so it is done whether the exchange ended
        naturally, hit a limit, was canceled, or never opened at all.
        """
        room, self._room = self._room, None
        try:
            if room is not None:
                await room.leave()
        finally:
            await self._delete_room()

    # -- The four places this driver touches the network ---------------------
    #
    # Making the room, dispatching into it, joining it, and deleting it —
    # and nothing else in this file reaches anywhere. Gathered here so that
    # a room-shaped fake standing in for a LiveKit is these four and no
    # more: every wait above, every ending, every sentence and every
    # scrubbing is then the real driver's, in CI as on a customer's server.

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
            metadata=dispatch_metadata(self._simulation_id),
        )
        await self._asked(
            request,
            f"the agent {self._settings.agent_name!r} could not be dispatched",
        )

    def _joined_room(self) -> JoinedRoom:
        """The way into the room, with a token that opens it and nothing
        else: one room, one identity, for the length of one simulation."""
        return JoinedRoom(
            url=self._settings.url,
            token=room_token(
                self._settings.api_key, self._settings.api_secret, self._room_name
            ),
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

        lkapi = api.LiveKitAPI(
            self._settings.url, self._settings.api_key, self._settings.api_secret
        )
        try:
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
            with contextlib.suppress(Exception):
                await lkapi.aclose()

    def _nobody_came(self, seconds: float) -> str:
        """Why nobody turned up, worded for whoever has to go and look."""
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
