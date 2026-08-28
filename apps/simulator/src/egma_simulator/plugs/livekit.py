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
- ``agentName`` (string, required) — the name the agent's worker
  registered under. Required rather than optional, because egma always
  dispatches explicitly: the record then names the agent it graded, and
  the customer's configured metadata always has a dispatch to ride.
- ``metadata`` (a JSON object in a string, optional) — the customer's
  own, for the agent to read. It is carried on the room verbatim and on
  the agent's dispatch too, which is where LiveKit's own documentation
  teaches an agent to look for its per-session context.

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
  POSTs to, once per simulation. The simulator repeats the HTTPS check before an
  auth header or room token can cross the network.

Its credentials are that endpoint's auth ``headers``. They are required. There
is no agent name and no metadata, because both are powers a key pair buys: this
shape holds none, so **dispatching is the endpoint's job** — and a room nobody
joined says exactly that.

## Media

The stock Pipecat LiveKit transport owns the room's input, output,
conversion, and pacing. Egma does not select or expose a processing rate.

## Answering for the agent's tools

A room is the one connection where egma can stand in the agent's tool
path, because it is the one where egma is already in the room with it. The
mock-tool exchange is offered on egma's own participant, and how the
agent's side finds it is the room itself: the name every simulation room
carries says a simulation is running, and the persona's participant
identity is the address — both published, both the same on all four ways
into a room, and neither of them a metadata channel the customer writes.
What answers it is :mod:`egma_simulator.mock_tools`, handed to this plug
already holding the answers the run resolved. Nothing about it is this
file's: the plug passes it to the driver that joins the room, and the
driver offers it there, at the join, before an agent that was quicker
into the room can ask.

## Where a turn begins and ends

Nowhere in here. A live room carries no end-of-turn signal. The one
running Pipecat pipeline reads those turns from the transport's frames.
"""

from __future__ import annotations

from typing import Any

from ..media import MediaBackendError, VoiceMedia
from ..media.livekit_room import LiveKitRoomBackend, RoomSettings
from ..mock_tools import MockToolSeam
from . import PlugError

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
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str,
        mock_tools: MockToolSeam | None = None,
        media: object = None,
        driver: Any = None,
    ) -> None:
        # A room is reached with this connection's URL and authority. It does
        # not use the deployment's phone media bridge or the platform carrier
        # resolved for a phone simulation.
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
        self._backend = build_driver(
            driver or LiveKitRoomBackend,
            settings=read_connection(access_variant, config, credentials),
            simulation_id=simulation_id,
            mock_tools=mock_tools,
        )
        self._media: VoiceMedia | None = None
        self._reference: str | None = None

    @property
    def provider_reference(self) -> str | None:
        """The room this exchange was conducted in, once there is one."""
        return self._reference

    @property
    def far_end_left(self) -> bool:
        """Whether the agent has left the room. There is no other signal
        and no better one: its participant leaving *is* the agent ending
        the exchange."""
        return self._media is not None and self._media.ended.is_set()

    @property
    def backend(self) -> object:
        """The driver holding the room.

        Here for the tests, honestly: a plug built from a spec alone
        builds its own driver, and this is the only way to ask which room
        the exchange was really held in before there is a reference.
        """
        return self._backend

    async def prepare(self) -> VoiceMedia:
        """Build the transport before the conductor starts its pipeline."""
        try:
            self._media = await self._backend.create_transport()
            return self._media
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def open(self) -> None:
        """Make the room and wait for the agent to turn up in it.

        Nothing is heard here. The line is open the moment the agent's
        audio flows. The running Pipecat transport then carries both
        sides, including the agent's opening.
        """
        try:
            await self._backend.dial()
            self._reference = await self._backend.wait_answered(AGENT_JOIN_SECONDS)
        except MediaBackendError as refused:
            raise PlugError(str(refused), ending=refused.ending) from refused

    async def close(self) -> None:
        """Leave, and delete the room. Safe from every state."""
        self._media = None
        await self._backend.teardown()


def read_connection(
    access_variant: str, config: dict[str, Any], credentials: object
) -> RoomSettings:
    """The connection, read by the driver that uses it, in the plug's words.

    Public because the chat plug next door reads the *same* connection
    block with the *same* driver and owes a refusal in the same words. A
    second copy of this would be a second set of sentences to keep true.
    """
    try:
        return RoomSettings.from_connection(access_variant, config, credentials)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused


def build_driver(factory, **arguments) -> Any:
    """One room driver, or the plug's own refusal in its words.

    Public for the reason above: both plugs build a driver, and both owe
    the same refusal when a connection turns out to be unusable.
    """
    try:
        return factory(**arguments)
    except MediaBackendError as refused:
        raise PlugError(str(refused), ending=refused.ending) from refused
