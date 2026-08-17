"""The livekit plug: the simulator joins the agent's own room.

The second plug that reaches an agent the way its customers do, and the
first that reaches one where it lives. A LiveKit agent is a worker
waiting to be given a room; so egma makes a room in the customer's own
LiveKit project, joins it, asks for the worker, and holds the exchange
there. What a spec names is a server, a key pair, and — where the
customer runs more than one agent — which agent to ask for.

The room itself is a media driver's job — see
:mod:`egma_simulator.media.livekit_room`, which owns the room whole: come
by a token and a room, join outbound, get the agent in where it can, learn
that it really turned up, and tidy up whatever happened. This module
owns the *lifecycle* above that seam, and it is deliberately thin: open,
carry the persona's speech out and the agent's speech back, notice the
agent leaving, end deliberately, and offer the room's name as the
provider reference — the one join between egma's record and the
platform's own telemetry.

Its config keys, like every plug's, are its own, and they are read by the
driver that uses them. There are two shapes of them, told apart by whether
``tokenEndpoint`` is there, and they are two answers to one question: who
mints the token that opens the room.

**egma mints it.** The connection carries the project's key pair, and egma
creates the room, dispatches the worker and deletes the room at the end:

- ``url`` (string, required) — the customer's LiveKit, ``ws``/``wss`` or
  ``http``/``https``. Cloud and self-hosted are the same URL and the same
  API; nothing here knows the difference.
- ``agentName`` (string, optional) — which agent to dispatch. Absent or
  blank: automatic dispatch, which is what a worker registered without a
  name already gets.
- ``metadata`` (a JSON object in a string, optional) — carried on the
  room, verbatim, for the agent to read.

Its credentials are the customer's LiveKit ``apiKey`` and ``apiSecret``.
Unlike a phone connection, a room connection carries its own: the room is
the customer's project, not this deployment's, so nothing about reaching
it comes from the environment.

**The customer mints it.** The connection names where egma asks instead,
and the secret that signs tokens for the whole project never leaves the
customer's side:

- ``url`` (string, required) — as above, and what the join falls back on
  where the endpoint's answer names no server of its own.
- ``tokenEndpoint`` (string, required) — the public ``https`` address egma
  POSTs to, once per simulation. Older stored HTTP values are refused before
  an auth header or room token can cross the network.

Its credentials are that endpoint's auth ``headers``. New connections require
them; the runtime still reads an older connection that has none. There is no agent name
and no metadata, because both are powers a key pair buys: this shape holds
none, so **dispatching is the endpoint's job** — and a room nobody joined
says exactly that.

## The band an exchange in a room is carried at

Always :data:`ROOM_BAND_HZ` — wideband, where a phone call is narrowband
— and there is no way to ask for another. WebRTC negotiates its own codec
and the transport resamples what arrives, so what a record stamps is
measured off the audio the recorder really saw.

## Answering for the agent's tools

A room is the one connection where egma can stand in the agent's tool
path, because it is the one where egma is already in the room with it. The
mock-tool exchange is offered on egma's own participant and the agent's
side is told where to find it in the dispatch metadata; what answers it is
:mod:`egma_simulator.mock_tools`, handed to this plug already holding the
answers the run resolved. Nothing about it is this file's: the plug passes
it to the driver that joins the room, and the driver offers it there.

## Where a turn begins and ends

Nowhere in here. A live room carries no end-of-turn signal any more than a
phone line does, so this plug declares none: it is a **duplex line**,
driven one slice of audio at a time with both directions open at once, and
where the turns fall is the conductor's reading of that audio. What every
plug over a live line shares — turning the transport's own frames into
slices of the same width — is :mod:`egma_simulator.plugs.media_line`.
"""

from __future__ import annotations

from typing import Any

from ..media import MediaBackendError
from ..media.livekit_room import ROOM_BAND_HZ, LiveKitRoomBackend, RoomSettings
from ..mock_tools import MockToolSeam
from . import PlugError
from .media_line import MediaLine

AGENT_JOIN_SECONDS = 30.0
"""How long the room may stand empty before nobody coming is the answer.

Long enough for a worker to be woken, given the room, and to publish its
first audio; short of a simulation's duration limit doing the job
instead, which would put ``limit_reached`` on a record whose real story is
that nothing ever turned up.
"""


class LiveKitRoom:
    """One exchange with an agent in its own room, per instance."""

    def __init__(
        self,
        *,
        modality: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        mock_tools: MockToolSeam | None = None,
        media: object = None,
        driver: Any = None,
    ) -> None:
        # A room is reached over the deployment's own media server, whose
        # address and credential are this container's bootstrap
        # configuration rather than a platform setting — so the carrier
        # resolved for this simulation is nothing to this plug.
        del media

        if modality != "voice":
            raise PlugError(
                f"the livekit plug speaks voice only; a {modality!r} "
                "simulation in a room is not a thing that exists"
            )

        # Reading the connection here, before any pipeline starts, is what
        # makes a connection the driver cannot use an honest refusal
        # rather than a failure part-way through an exchange.
        #
        # Which driver holds the room is not the spec's to choose: there is
        # one, and it is the one below. The keyword is for tests, which put
        # a room-shaped fake behind the same seam rather than stand up a
        # LiveKit.
        self._band_hz = ROOM_BAND_HZ
        self._backend = _built(
            driver or LiveKitRoomBackend,
            settings=_read(config, credentials),
            band_hz=self._band_hz,
            simulation_id=simulation_id,
            mock_tools=mock_tools,
        )
        self._line: MediaLine | None = None
        self._reference: str | None = None

    @property
    def provider_reference(self) -> str | None:
        """The room this exchange was conducted in, once there is one."""
        return self._reference

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def measured_band_hz(self) -> int | None:
        """The band this exchange really carried, read off its audio."""
        return None if self._line is None else self._line.measured_band_hz

    @property
    def far_end_left(self) -> bool:
        """Whether the agent has left the room. There is no other signal
        and no better one: its participant leaving *is* the agent ending
        the exchange."""
        return self._line is not None and self._line.far_end_left

    @property
    def backend(self) -> object:
        """The driver holding the room.

        Here for the tests, honestly: a plug built from a spec alone
        builds its own driver, and this is the only way to ask which room
        the exchange was really held in before there is a reference.
        """
        return self._backend

    async def open(self) -> None:
        """Make the room and wait for the agent to turn up in it.

        Nothing is heard here. The line is open the moment the agent's
        audio flows, and every sample either side says after that crosses
        it through :meth:`exchange` — including the agent's opening,
        which in a real room is simply the first thing it happens to say.
        """
        try:
            session = await self._backend.create_session()
            await self._backend.dial()
            self._reference = await self._backend.wait_answered(AGENT_JOIN_SECONDS)
            self._line = MediaLine(session, band_hz=self._band_hz)
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def exchange(self, outgoing: bytes) -> bytes:
        """One slice of the exchange, both directions at once."""
        line = self._line
        if line is None:
            raise PlugError("the room was driven before the agent was in it")
        try:
            return await line.carry(outgoing)
        except MediaBackendError as failed:
            # A room that goes wrong mid-exchange is the driver's to name
            # and the plug's to carry: a fault, never an agent that never
            # joined, because one did join.
            raise PlugError(str(failed), ending=failed.ending) from failed

    async def close(self) -> None:
        """Leave, and delete the room. Safe from every state."""
        self._line = None
        await self._backend.teardown()


def _read(config: dict[str, Any], credentials: object) -> RoomSettings:
    """The connection, read by the driver that uses it, in the plug's words."""
    try:
        return RoomSettings.from_connection(config, credentials)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused


def _built(factory, **arguments) -> Any:
    """One room driver, or the plug's own refusal in its words."""
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
